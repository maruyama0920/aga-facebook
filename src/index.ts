import "dotenv/config";
import express from "express";
import nodemailer from "nodemailer";
import crypto from "crypto";
import fetch from "node-fetch";

// 設定
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN!;
const FB_APP_SECRET = process.env.FB_APP_SECRET!;

// Facebook Graph API URL
const FB_GRAPH_API_URL = "https://graph.facebook.com/v21.0/me/messages";

// メール送信設定
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// メッセージ履歴の管理
const messageHistory = new Map<string, { text: string; timestamp: string }[]>();
const pendingApprovals = new Map<string, { text: string; timestamp: string }>();

// 電話番号検出用の正規表現（基本的な形式）
function isValidPhoneNumber(number: string): boolean {
  // ハイフンを除去して純粋な数字列にする
  const digitsOnly = number.replace(/-/g, "");

  // 先頭が0で始まることを確認
  if (!digitsOnly.startsWith("0")) return false;

  // 携帯電話（090/080/070で始まる11桁）
  if (digitsOnly.match(/^0[789]0/) && digitsOnly.length === 11) return true;

  // 固定電話（0で始まる10桁）
  if (digitsOnly.length === 10) return true;

  return false;
}

// 電話番号らしき文字列の検出用（半角数字のみ）
const POSSIBLE_PHONE_PATTERN = /[0-9]{6,}/;

// 電話番号を抽出して検証する関数
function extractAndValidatePhoneNumber(text: string): {
  isValid: boolean;
  number?: string;
  hasInvalidChars?: boolean;
} {
  // 電話番号らしき文字列を探す
  const phoneMatch = text.match(/0[0-9-０-９]+/);
  if (!phoneMatch) return { isValid: false };

  // 全角数字を半角に変換
  const normalized = phoneMatch[0].replace(/[０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0)
  );

  // 無効な文字（数字とハイフン以外）のチェック
  const hasInvalidChars = /[^0-9-]/.test(normalized);
  if (hasInvalidChars) {
    return {
      isValid: false,
      hasInvalidChars: true,
    };
  }

  // 数字のみ抽出
  const number = normalized.replace(/-/g, "");

  // 電話番号の形式チェック
  const isValid = isValidPhoneNumber(number);

  return {
    isValid,
    number,
    hasInvalidChars: false,
  };
}

// Expressサーバーの設定
const app = express();
app.use(express.json({ verify: verifyRequestSignature }));

app.get("/", (_req, res) => res.send("Facebook Messenger Bot running"));

// Webhook検証エンドポイント（Facebook用）
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("Webhook検証成功");
    res.status(200).send(challenge);
  } else {
    console.log("Webhook検証失敗");
    res.sendStatus(403);
  }
});

// Webhookエンドポイント（メッセージ受信）
app.post("/webhook", async (req, res) => {
  console.log("Webhookイベントを受信:", JSON.stringify(req.body, null, 2));
  
  const body = req.body;
  
  if (body.object === "page") {
    for (const entry of body.entry) {
      const webhookEvent = entry.messaging?.[0];
      if (webhookEvent) {
        await handleEvent(webhookEvent);
      }
    }
    res.status(200).send("EVENT_RECEIVED");
  } else {
    res.sendStatus(404);
  }
});

// リクエスト署名の検証
function verifyRequestSignature(req: any, res: any, buf: Buffer) {
  const signature = req.headers["x-hub-signature-256"];
  if (!signature) {
    console.warn("署名ヘッダーがありません");
    return;
  }

  const elements = signature.split("=");
  const signatureHash = elements[1];
  const expectedHash = crypto
    .createHmac("sha256", FB_APP_SECRET)
    .update(buf)
    .digest("hex");

  if (signatureHash !== expectedHash) {
    throw new Error("リクエスト署名の検証に失敗しました");
  }
}

// Facebook Messengerにメッセージを送信
async function sendMessage(recipientId: string, message: any) {
  try {
    const response = await fetch(FB_GRAPH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: message,
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    });

    const data = await response.json();
    console.log("メッセージ送信成功:", data);
    return data;
  } catch (error) {
    console.error("メッセージ送信エラー:", error);
    throw error;
  }
}

// メッセージ処理
async function handleEvent(event: any) {
  console.log("イベント処理開始:", JSON.stringify(event, null, 2));

  const senderId = event.sender?.id;
  if (!senderId) {
    console.log("送信者IDが見つかりません");
    return;
  }

  // メッセージイベントの処理
  if (event.message) {
    const text = event.message.text;
    if (!text) {
      console.log("テキストメッセージ以外をスキップ");
      return;
    }

    const timestamp = new Date(event.timestamp).toISOString();
    console.log("メッセージを受信:", { senderId, text, timestamp });

    // メッセージを履歴に追加
    if (!messageHistory.has(senderId)) {
      messageHistory.set(senderId, []);
    }
    messageHistory.get(senderId)?.push({ text, timestamp });

    // 承認応答の処理
    if (text === "はい、大丈夫です") {
      console.log("承認応答を受信:", { senderId });
      await handleApproval(senderId);
    }
    // 承認拒否の処理
    else if (text === "いいえ、結構です") {
      console.log("承認拒否を受信:", { senderId });
      await handleRejection(senderId);
    }
    // 電話番号の処理
    else {
      const { isValid, number, hasInvalidChars } =
        extractAndValidatePhoneNumber(text);
      if (isValid && number) {
        console.log("有効な電話番号を検出:", { senderId, number });
        await showConfirmation(senderId);
      } else if (hasInvalidChars) {
        console.log("無効な電話番号フォーマットを検出:", {
          senderId,
          text,
          hasInvalidChars,
        });
        await handleInvalidPhoneNumber(senderId);
      } else {
        console.log("通常のメッセージを受信:", { senderId, text });
      }
    }
  }
  // ポストバックイベントの処理（Quick Replyからの応答）
  else if (event.postback) {
    const payload = event.postback.payload;
    console.log("ポストバックを受信:", { senderId, payload });

    if (payload === "APPROVE") {
      await handleApproval(senderId);
    } else if (payload === "REJECT") {
      await handleRejection(senderId);
    }
  }
}

// 承認時の処理
async function handleApproval(userId: string) {
  console.log("承認処理を開始:", { userId });
  const pendingData = pendingApprovals.get(userId);
  if (!pendingData) {
    console.log("承認待ちデータが見つかりません:", { userId });
    return;
  }

  try {
    // メール送信
    const toAddresses = process.env.MAIL_TO?.split(",")
      .map((email) => email.trim())
      .filter((email) => email.length > 0)
      .join(",");

    console.log("メール送信を試行:", {
      from: process.env.GMAIL_USER,
      to: toAddresses,
      userId,
      messageHistory: messageHistory.get(userId),
    });

    await transporter.sendMail({
      from: process.env.GMAIL_USER,
      to: toAddresses,
      subject: "Facebook Messenger問い合わせ【AGAクリニック比較サイト】aga_facebook",
      text: formatMailBody(userId),
    });

    console.log("メール送信成功");

    // Facebook Messengerで返信
    await sendMessage(userId, {
      text: "ありがとうございます。\n専門スタッフよりご連絡させていただきます。\nしばらくお待ちください。",
    });

    // クリーンアップ
    messageHistory.delete(userId);
    pendingApprovals.delete(userId);
  } catch (error) {
    console.error("エラー発生:", error);
  }
}

// 確認メッセージの表示
async function showConfirmation(userId: string) {
  console.log("確認メッセージを表示:", { userId });

  // 承認待ちリストに追加
  const timestamp = new Date().toISOString();
  pendingApprovals.set(userId, { text: "電話確認待ち", timestamp });

  // Quick Replyで確認メッセージを送信
  await sendMessage(userId, {
    text: "専門スタッフからご連絡\n\n最短当日または翌営業日、専門スタッフからご連絡してもよろしいでしょうか？",
    quick_replies: [
      {
        content_type: "text",
        title: "はい、大丈夫です",
        payload: "APPROVE",
      },
      {
        content_type: "text",
        title: "いいえ、結構です",
        payload: "REJECT",
      },
    ],
  });
}

// 承認拒否時の処理
async function handleRejection(userId: string) {
  // まずメッセージを送信
  await sendMessage(userId, {
    text: "承知いたしました！気になる点がありましたら、いつでもお気軽にお問合せください",
  });

  // 少し待ってから確認カードを再表示
  setTimeout(async () => {
    await showConfirmation(userId);
  }, 1000);

  pendingApprovals.delete(userId);
}

// メール本文のフォーマット
function formatMailBody(userId: string): string {
  const history = messageHistory.get(userId);
  if (!history) return "";

  return `[ID] : ${userId}\n\n=== メッセージ履歴 ===\n${history
    .map((msg) => `[${msg.timestamp}]\n${msg.text}\n`)
    .join("\n")}`;
}

// 無効な電話番号の処理
async function handleInvalidPhoneNumber(userId: string) {
  await sendMessage(userId, {
    text: "申し訳ありません。電話番号の形式が正しくないようです。\n\n以下のような形式で電話番号を入力してください：\n・携帯電話の場合：090-1234-5678\n・固定電話の場合：03-1234-5678",
  });
}

// フォーマットガイドの表示
async function handleFormatGuide(userId: string) {
  await sendMessage(userId, {
    text: "以下の形式で入力してください：\n\n【お名前】山田太郎\n【電話番号】090-1234-5678",
  });
}

// サーバー起動
const port = Number(process.env.PORT || 8080);
app.listen(port, () => console.log(`Listening http://localhost:${port}`));
