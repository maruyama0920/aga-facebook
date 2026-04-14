import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
import nodemailer from "nodemailer";

// 設定
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN!;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN!;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const SKIP_SIGNATURE_VERIFICATION = process.env.SKIP_SIGNATURE_VERIFICATION === "true";

// Facebook Graph API URL
const FB_GRAPH_API_URL = "https://graph.facebook.com/v21.0/me/messages";

/** Messenger テンプレート用（タイトル等の上限対策） */
function truncateForMessenger(text: string, maxChars: number): string {
  const chars = Array.from(text);
  if (chars.length <= maxChars) return text;
  return chars.slice(0, maxChars - 1).join("") + "…";
}

/** 画像は HTTPS の公開 URL のみ（未設定・不正時は undefined） */
function readMessengerImageUrl(envKey: string): string | undefined {
  const raw = process.env[envKey];
  if (!raw?.trim()) return undefined;
  const v = raw.trim();
  try {
    const u = new URL(v);
    if (u.protocol !== "https:") {
      console.warn(`[Messenger] ${envKey} は https の URL を指定してください`);
      return undefined;
    }
    return v;
  } catch {
    console.warn(`[Messenger] ${envKey} が無効な URL です`);
    return undefined;
  }
}

// メール送信設定
const transporter = nodemailer.createTransport({
  service: "gmail",
  auth: {
    user: process.env.GMAIL_USER,
    pass: process.env.GMAIL_APP_PASSWORD,
  },
});

// ユーザーの状態管理
interface UserState {
  step: string;
  answers: {
    q1?: string;
    q2?: string;
    q3?: string;
    q4?: string;
    q5?: string;
    q6?: string;
  };
  name?: string;
  phone?: string;
}

const userStates = new Map<string, UserState>();

// Expressサーバーの設定
const app = express();

if (SKIP_SIGNATURE_VERIFICATION) {
  console.log("⚠ 警告: 署名検証をスキップします（テストモード）");
  app.use(express.json());
} else {
  console.log("✓ 署名検証を有効化");
  app.use(express.json({ verify: verifyRequestSignature }));
}

app.get("/", (_req, res) => res.send("Facebook Messenger Bot - Test Mode"));

// Webhook検証エンドポイント（Facebook用）
app.get("/webhook", (req, res) => {
  const mode = req.query["hub.mode"];
  const token = req.query["hub.verify_token"];
  const challenge = req.query["hub.challenge"];

  console.log("=== Webhook検証リクエスト ===");
  console.log("Mode:", mode);
  console.log("Token:", token);
  console.log("Challenge:", challenge);

  if (mode === "subscribe" && token === FB_VERIFY_TOKEN) {
    console.log("✓ Webhook検証成功");
    res.status(200).send(challenge);
  } else {
    console.log("✗ Webhook検証失敗");
    res.sendStatus(403);
  }
});

// Webhookエンドポイント（メッセージ受信）
app.post("/webhook", async (req, res) => {
  console.log("\n=== Webhookイベント受信 ===");
  console.log("受信時刻:", new Date().toISOString());
  console.log("リクエストボディ:", JSON.stringify(req.body, null, 2));

  const body = req.body;

  if (body.object === "page") {
    for (const entry of body.entry) {
      console.log("\n--- Entry ---");
      console.log("Entry ID:", entry.id);
      console.log("Entry Time:", new Date(entry.time).toISOString());

      const webhookEvent = entry.messaging?.[0];
      if (webhookEvent) {
        await handleWebhookEvent(webhookEvent);
      }
    }

    console.log("\n=== 処理完了 ===\n");
    res.status(200).send("EVENT_RECEIVED");
  } else {
    console.log("✗ ページイベントではありません");
    res.sendStatus(404);
  }
});

// Webhookイベントの分岐処理
async function handleWebhookEvent(event: any) {
  const senderId = event.sender?.id;
  if (!senderId) return;

  // メッセージイベント
  if (event.message) {
    await handleMessage(senderId, event.message);
  }
  // ポストバックイベント
  else if (event.postback) {
    await handlePostback(senderId, event.postback);
  }
  // リファラルイベント（友だち追加）
  else if (event.referral) {
    await handleReferral(senderId, event.referral);
  }
}

// メッセージイベントの処理
async function handleMessage(senderId: string, message: any) {
  const text = message.text;
  if (!text) return;

  console.log(`[MESSAGE] ${senderId}: ${text}`);

  const userState = userStates.get(senderId);

  // 名前・電話番号入力待ちの場合
  if (userState?.step === "WAITING_CONTACT") {
    await handleContactInput(senderId, text);
    return;
  }

  // 「無料診断してみる」で診断スタート
  if (text === "無料診断してみる" || text === "診断" || text === "スタート") {
    await sendWelcomeMessage(senderId);
    return;
  }

  // デバッグ用: 「クリアして」で状態クリア
  if (text === "クリアして" || text === "クリア" || text === "リセット") {
    userStates.delete(senderId);
    await sendTextMessage(senderId, "状態をクリアしました。\n「無料診断してみる」と送信すると診断を開始できます。");
    console.log(`[DEBUG] 状態クリア: ${senderId}`);
    return;
  }

  // デバッグ用: 「ボタン」でボタンテスト
  if (text === "ボタン") {
    await sendButtonTemplate(senderId, "ボタンのテストです", [
      { title: "テスト1", payload: "TEST_1" },
      { title: "テスト2", payload: "TEST_2" }
    ]);
    return;
  }

  // その他のメッセージ: 案内を表示
  await sendTextMessage(senderId, "「無料診断してみる」と送信すると、AGAクリニック診断を開始できます！");
}

// ポストバックイベントの処理
async function handlePostback(senderId: string, postback: any) {
  const payload = postback.payload;
  console.log(`[POSTBACK] ${senderId}: ${payload}`);

  // 診断スタート
  if (payload === "START_DIAGNOSIS") {
    await startDiagnosis(senderId);
  }
  // 質問1の回答
  else if (payload.startsWith("Q1_")) {
    await handleQ1Answer(senderId, payload);
  }
  // 質問2の回答
  else if (payload.startsWith("Q2_")) {
    await handleQ2Answer(senderId, payload);
  }
  // 質問3の回答
  else if (payload.startsWith("Q3_")) {
    await handleQ3Answer(senderId, payload);
  }
  // 質問4の回答
  else if (payload.startsWith("Q4_")) {
    await handleQ4Answer(senderId, payload);
  }
  // 質問5の回答
  else if (payload.startsWith("Q5_")) {
    await handleQ5Answer(senderId, payload);
  }
  // 質問6の回答
  else if (payload.startsWith("Q6_")) {
    await handleQ6Answer(senderId, payload);
  }
  // 診断結果を見る
  else if (payload.startsWith("VIEW_RESULT_")) {
    await showDiagnosisResult(senderId, payload);
  }
  // 無料カウンセリング予約
  else if (payload === "BOOK_COUNSELING") {
    await requestContact(senderId);
  }
  // もっと知りたい
  else if (payload === "MORE_INFO") {
    await showMoreInfo(senderId);
  }
  // デバッグ用
  else {
    await sendTextMessage(senderId, `ボタンをクリックしました: ${payload}`);
  }
}

// リファラルイベントの処理
async function handleReferral(senderId: string, referral: any) {
  console.log(`[REFERRAL] ${senderId}: ${referral.source}`);
  // リファラルでも案内を表示
  await sendTextMessage(senderId, "こんにちは！AGAクリニック選びの診断ボットです。\n\n「無料診断してみる」と送信すると診断を開始できます！");
}

// Send API: テキストメッセージを送信
async function sendTextMessage(recipientId: string, text: string) {
  try {
    const response = await fetch(FB_GRAPH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: { text: text },
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error(`[ERROR] メッセージ送信失敗: ${response.status}`, data);
    }

    return data;
  } catch (error) {
    console.error("[ERROR] メッセージ送信エラー:", error);
    throw error;
  }
}

// ===== 診断フロー =====

// あいさつメッセージ
async function sendWelcomeMessage(senderId: string) {
  await sendTextMessage(senderId, "友だち追加ありがとうございます！\nAGAクリニック選び　かんたん診断です\n\nAGA治療を検討する中で、\n「自分に合うクリニックが分からない…」と感じる方はとても多いです。");
  
  await sendTextMessage(senderId, "そこで、\n○○○さんに合ったクリニックが分かる簡単な診断をご用意しました！\n\nまずはお気軽に答えてみてください😊");
  
  const welcomeImg = readMessengerImageUrl("IMAGE_WELCOME");
  await sendInteractiveCard(senderId, {
    title: "タップして診断スタート！",
    subtitle: "下のボタンから進めます",
    ...(welcomeImg ? { imageUrl: welcomeImg } : {}),
    buttons: [{ title: "診断スタート", payload: "START_DIAGNOSIS" }],
  });
}

// 診断開始
async function startDiagnosis(senderId: string) {
  userStates.set(senderId, { step: "Q1", answers: {} });
  await sendQuestion1(senderId);
}

// 質問1
async function sendQuestion1(senderId: string) {
  const img = readMessengerImageUrl("IMAGE_Q1");
  await sendInteractiveCard(senderId, {
    title: "現在の髪の状態に近いものはどれですか？",
    subtitle: "あてはまるものを選んでください",
    ...(img ? { imageUrl: img } : {}),
    buttons: [
      { title: "生え際が少し後退してきた気がする", payload: "Q1_A" },
      { title: "頭頂部の地肌が透けて見えることがある", payload: "Q1_B" },
      { title: "後頭部のボリュームが減った気がする", payload: "Q1_C" },
    ],
  });
}

async function handleQ1Answer(senderId: string, payload: string) {
  const state = userStates.get(senderId) || { step: "Q1", answers: {} };
  state.answers.q1 = payload;
  state.step = "Q2";
  userStates.set(senderId, state);
  await sendQuestion2(senderId);
}

// 質問2
async function sendQuestion2(senderId: string) {
  const img = readMessengerImageUrl("IMAGE_Q2");
  await sendInteractiveCard(senderId, {
    title: "どれくらい前から悩んでいますか？",
    subtitle: "あてはまるものを選んでください",
    ...(img ? { imageUrl: img } : {}),
    buttons: [
      { title: "数カ月くらい悩んでいる", payload: "Q2_A" },
      { title: "半年～1年くらい悩んでいる", payload: "Q2_B" },
      { title: "1年以上悩んでいる", payload: "Q2_C" },
    ],
  });
}

async function handleQ2Answer(senderId: string, payload: string) {
  const state = userStates.get(senderId) || { step: "Q2", answers: {} };
  state.answers.q2 = payload;
  state.step = "Q3";
  userStates.set(senderId, state);
  await sendQuestion3(senderId);
}

// 質問3
async function sendQuestion3(senderId: string) {
  const img = readMessengerImageUrl("IMAGE_Q3");
  await sendInteractiveCard(senderId, {
    title: "どんなときにAGAを意識しますか？",
    subtitle: "あてはまるものを選んでください",
    ...(img ? { imageUrl: img } : {}),
    buttons: [
      { title: "鏡や写真を見たときに意識する", payload: "Q3_A" },
      { title: "人に会うときに意識する", payload: "Q3_B" },
      { title: "抜け毛を見たときに意識する", payload: "Q3_C" },
    ],
  });
}

async function handleQ3Answer(senderId: string, payload: string) {
  const state = userStates.get(senderId) || { step: "Q3", answers: {} };
  state.answers.q3 = payload;
  state.step = "Q4";
  userStates.set(senderId, state);
  await sendQuestion4(senderId);
}

// 質問4
async function sendQuestion4(senderId: string) {
  const img = readMessengerImageUrl("IMAGE_Q4");
  await sendInteractiveCard(senderId, {
    title: "今の気持ちに近いものはどれですか？",
    subtitle: "あてはまるものを選んでください",
    ...(img ? { imageUrl: img } : {}),
    buttons: [
      { title: "将来、手遅れにならないか不安", payload: "Q4_A" },
      { title: "印象が悪くなりそうで不安", payload: "Q4_B" },
      { title: "自信が持てなくなりそう", payload: "Q4_C" },
    ],
  });
}

async function handleQ4Answer(senderId: string, payload: string) {
  const state = userStates.get(senderId) || { step: "Q4", answers: {} };
  state.answers.q4 = payload;
  state.step = "Q5";
  userStates.set(senderId, state);
  await sendQuestion5(senderId);
}

// 質問5
async function sendQuestion5(senderId: string) {
  const img = readMessengerImageUrl("IMAGE_Q5");
  await sendInteractiveCard(senderId, {
    title: "AGA治療薬を使ったことはありますか？",
    subtitle: "あてはまるものを選んでください",
    ...(img ? { imageUrl: img } : {}),
    buttons: [
      { title: "現在、AGA治療薬使っている", payload: "Q5_A" },
      { title: "過去にAGA治療薬を使っていた", payload: "Q5_B" },
      { title: "AGA治療薬を使ったことはない", payload: "Q5_C" },
    ],
  });
}

async function handleQ5Answer(senderId: string, payload: string) {
  const state = userStates.get(senderId) || { step: "Q5", answers: {} };
  state.answers.q5 = payload;
  state.step = "Q6";
  userStates.set(senderId, state);
  await sendQuestion6(senderId);
}

// 質問6
async function sendQuestion6(senderId: string) {
  const img = readMessengerImageUrl("IMAGE_Q6");
  await sendInteractiveCard(senderId, {
    title: "クリニック選びで重視したい点は？",
    subtitle: "あてはまるものを選んでください",
    ...(img ? { imageUrl: img } : {}),
    buttons: [
      { title: "【重視】周りに知られずに治療できる", payload: "Q6_PRIVACY" },
      { title: "【重視】効果をしっかり実感したい", payload: "Q6_EFFECT" },
      { title: "【重視】無理なく続けられる価格", payload: "Q6_PRICE" },
    ],
  });
}

async function handleQ6Answer(senderId: string, payload: string) {
  const state = userStates.get(senderId) || { step: "Q6", answers: {} };
  state.answers.q6 = payload;
  state.step = "RESULT";
  userStates.set(senderId, state);
  
  // 診断結果誘導
  await sendResultPrompt(senderId, payload);
}

// 診断結果誘導
async function sendResultPrompt(senderId: string, q6Answer: string) {
  let resultPayload = "VIEW_RESULT_PRIVACY";
  
  if (q6Answer === "Q6_EFFECT") {
    resultPayload = "VIEW_RESULT_EFFECT";
  } else if (q6Answer === "Q6_PRICE") {
    resultPayload = "VIEW_RESULT_PRICE";
  }

  const ctaImg = readMessengerImageUrl("IMAGE_RESULT_CTA");
  await sendInteractiveCard(senderId, {
    title: "タップして診断結果をみる",
    subtitle: "結果画面へ進みます",
    ...(ctaImg ? { imageUrl: ctaImg } : {}),
    buttons: [{ title: "診断結果をみる！", payload: resultPayload }],
  });
}

// 診断結果表示
async function showDiagnosisResult(senderId: string, payload: string) {
  if (payload === "VIEW_RESULT_PRIVACY") {
    await showPrivacyResult(senderId);
  } else if (payload === "VIEW_RESULT_EFFECT") {
    await showEffectResult(senderId);
  } else if (payload === "VIEW_RESULT_PRICE") {
    await showPriceResult(senderId);
  }
}

// 診断結果1: プライバシー重視
async function showPrivacyResult(senderId: string) {
  const hero = readMessengerImageUrl("IMAGE_RESULT_PRIVACY");
  if (hero) await sendImageMessage(senderId, hero);

  await sendTextMessage(senderId, "質問6で「周りに知られずに治療できる」を選択\n\nあなたにおすすめのクリニックは\nプライバシーに配慮されたクリニック\n\n【見るべきポイント】\n・人と顔を合わせずに治療を始められるか\n・来院しても、他の患者と会わずに済むか");
  
  await sendTextMessage(senderId, "そんなあなたにおすすめのクリニックは\nAGAヘアクリニック\n\nオンライン診療、来院診療でもプライバシーに配慮\n・オンライン診療なら、人目を気にせず診察可能\n・来院診療なら、完全個室で受付からお会計まで個室内で完結");
  
  await sendTextMessage(senderId, "さらに、\n診察は何度でも無料\n始めやすい\n維持予防プラン初月1800円～\n発毛プラン初月888円～");
  
  await sendCounselingPrompt(senderId);
}

// 診断結果2: 効果重視
async function showEffectResult(senderId: string) {
  const hero = readMessengerImageUrl("IMAGE_RESULT_EFFECT");
  if (hero) await sendImageMessage(senderId, hero);

  await sendTextMessage(senderId, "質問6で「効果をしっかり実感したい」を選択\n\nあなたにおすすめのクリニックは\n実績と信頼のあるクリニック\n\n【見るべきポイント】\n・AGA治療を専門に扱っているか\n・状態に合わせて治療内容を調整できるか");
  
  await sendTextMessage(senderId, "そんなあなたにおすすめのクリニックは\nAGAヘアクリニック\n\n・診療実績100万件以上\n・発毛実感率99％\n・副作用フォロー\n・遺伝子検査で自分に最適な治療\n・毛髪診断士による最適なカウンセリングとホスピタリティ");
  
  await sendTextMessage(senderId, "さらに、\n診察は何度でも無料\n始めやすい\n維持予防プラン初月1800円～\n発毛プラン初月888円～");
  
  await sendCounselingPrompt(senderId);
}

// 診断結果3: 価格重視
async function showPriceResult(senderId: string) {
  const hero = readMessengerImageUrl("IMAGE_RESULT_PRICE");
  if (hero) await sendImageMessage(senderId, hero);

  await sendTextMessage(senderId, "質問6で「無理なく続けられる価格」を選択\n\nあなたにおすすめのクリニックは\nコスパ重視のクリニック\n\n【見るべきポイント】\n・診察料の価格\n・割引キャンペーン\n・診察料や追加費用がかからないか\n・自分のペースで治療を続けられるか");
  
  await sendTextMessage(senderId, "そんなあなたにおすすめのクリニックは\nAGAヘアクリニック\n\n・診察（初診・再診・カウンセリング料）は何度でも無料\n・治療内容に応じた複数プランを用意\n・初めての方でも始めやすい価格帯\n\n始めやすい\n維持予防プラン初月1800円～\n発毛プラン初月888円～");
  
  await sendCounselingPrompt(senderId);
}

// カウンセリング誘導
async function sendCounselingPrompt(senderId: string) {
  const img = readMessengerImageUrl("IMAGE_COUNSELING");
  await sendInteractiveCard(senderId, {
    title: "まずは、AGAヘアクリニックで無料カウンセリングを受けてみませんか？",
    subtitle: "ご希望に合わせてご案内します",
    ...(img ? { imageUrl: img } : {}),
    buttons: [
      { title: "無料カウンセリングを予約をする", payload: "BOOK_COUNSELING" },
      { title: "AGAヘアクリニックについてもっと知りたい", payload: "MORE_INFO" },
    ],
  });
}

// もっと知りたい
async function showMoreInfo(senderId: string) {
  await sendTextMessage(senderId, "AGAヘアクリニックの6つの特徴\n・来院、オンラインを選べる\n・完全個室でプライバシー配慮\n・最長60分カウンセリング\n・定期的な効果測定\n・遺伝子検査による最適なお薬判定\n・専門医による徹底サポート");
  
  const moreImg = readMessengerImageUrl("IMAGE_MORE_INFO");
  await sendInteractiveCard(senderId, {
    title: "無料カウンセリングへ",
    subtitle: "下のボタンからお進みください",
    ...(moreImg ? { imageUrl: moreImg } : {}),
    buttons: [{ title: "無料カウンセリングを予約をする", payload: "BOOK_COUNSELING" }],
  });
}

// 連絡先入力リクエスト
async function requestContact(senderId: string) {
  const state = userStates.get(senderId) || { step: "WAITING_CONTACT", answers: {} };
  state.step = "WAITING_CONTACT";
  userStates.set(senderId, state);
  
  await sendTextMessage(senderId, "ご検討ありがとうございます！\n専門スタッフからご案内させていただくため、\nお名前と連絡先の電話番号をご入力ください。");
}

// 連絡先入力処理
async function handleContactInput(senderId: string, text: string) {
  console.log(`[CONTACT] ${senderId}: ${text}`);
  
  const result = parseContactInfo(text);
  
  if (!result.isValid) {
    await sendTextMessage(senderId, result.errorMessage!);
    return;
  }

  // 有効な連絡先情報を保存
  const state = userStates.get(senderId);
  if (state && result.name && result.phone) {
    state.name = result.name;
    state.phone = result.phone;
    userStates.set(senderId, state);
  }

  console.log(`[CONTACT_OK] 名前: ${result.name}, 電話: ${result.phone}`);
  
  // メール送信
  try {
    await sendEmailNotification(senderId, result.name!, result.phone!, state);
    console.log(`[EMAIL_SENT] ${senderId}`);
  } catch (error) {
    console.error(`[EMAIL_ERROR] ${senderId}:`, error);
  }
  
  await sendTextMessage(senderId, "ありがとうございます。\n専門スタッフよりご連絡させていただきます。\nしばらくお待ちください。");
  
  // 状態をクリア
  userStates.delete(senderId);
  console.log(`[STATE_CLEARED] ${senderId}`);
}

// 連絡先情報の解析
function parseContactInfo(text: string): {
  isValid: boolean;
  name?: string;
  phone?: string;
  errorMessage?: string;
} {
  // 名前と電話番号のパターン
  const patterns = [
    // パターン1: 【お名前】山田太郎 【電話番号】090-1234-5678
    /【お名前】\s*([^\s【】]+)\s*【電話番号】\s*([0-9０-９\-]+)/,
    // パターン2: 名前: 山田太郎 電話: 090-1234-5678
    /名前[:：]\s*([^\s\n]+)\s*電話[:：]\s*([0-9０-９\-]+)/,
    // パターン3: 山田太郎 090-1234-5678（スペース区切り）
    /^([^\s0-9０-９]+)\s+([0-9０-９\-]+)$/,
    // パターン4: 改行区切り
    /^([^\s0-9０-９\n]+)\n+([0-9０-９\-]+)$/,
  ];

  for (const pattern of patterns) {
    const match = text.match(pattern);
    if (match && match[1] && match[2]) {
      const name = match[1].trim();
      const phoneRaw = match[2].trim();
      
      // 電話番号の検証
      const phoneValidation = validatePhoneNumber(phoneRaw);
      
      if (!phoneValidation.isValid) {
        return {
          isValid: false,
          errorMessage: phoneValidation.errorMessage || "電話番号が無効です。"
        };
      }

      // 名前の検証（2文字以上）
      if (name.length < 2) {
        return {
          isValid: false,
          errorMessage: "お名前は2文字以上で入力してください。"
        };
      }

      return {
        isValid: true,
        name: name,
        phone: phoneValidation.phone || ""
      };
    }
  }

  // パターンに一致しない場合
  return {
    isValid: false,
    errorMessage: "申し訳ありません。入力形式が正しくないようです。\n\n以下の形式で入力してください：\n\n【お名前】山田太郎\n【電話番号】090-1234-5678\n\nまたは\n\n山田太郎\n090-1234-5678"
  };
}

// 電話番号の検証
function validatePhoneNumber(phoneRaw: string): {
  isValid: boolean;
  phone?: string;
  errorMessage?: string;
} {
  // 全角数字を半角に変換
  const normalized = phoneRaw.replace(/[０-９]/g, (s) =>
    String.fromCharCode(s.charCodeAt(0) - 0xfee0)
  );

  // ハイフンを除去
  const digitsOnly = normalized.replace(/-/g, "");

  // 数字以外が含まれていないかチェック
  if (!/^[0-9]+$/.test(digitsOnly)) {
    return {
      isValid: false,
      errorMessage: "電話番号は半角数字とハイフンのみで入力してください。\n\n例: 090-1234-5678"
    };
  }

  // 先頭が0で始まることを確認
  if (!digitsOnly.startsWith("0")) {
    return {
      isValid: false,
      errorMessage: "電話番号は0から始まる必要があります。\n\n例: 090-1234-5678 または 03-1234-5678"
    };
  }

  // 携帯電話（090/080/070で始まる11桁）
  if (digitsOnly.match(/^0[789]0/) && digitsOnly.length === 11) {
    return {
      isValid: true,
      phone: digitsOnly
    };
  }

  // 固定電話（0で始まる10桁）
  if (digitsOnly.length === 10) {
    return {
      isValid: true,
      phone: digitsOnly
    };
  }

  // 桁数が合わない
  return {
    isValid: false,
    errorMessage: "電話番号の桁数が正しくありません。\n\n・携帯電話: 11桁（例: 090-1234-5678）\n・固定電話: 10桁（例: 03-1234-5678）"
  };
}

// ===== メール送信 =====

// メール送信
async function sendEmailNotification(
  senderId: string,
  name: string,
  phone: string,
  state: UserState | undefined
) {
  const toAddresses = process.env.MAIL_TO?.split(",")
    .map((email) => email.trim())
    .filter((email) => email.length > 0)
    .join(",");

  if (!toAddresses) {
    console.error("[EMAIL_ERROR] MAIL_TO が設定されていません");
    return;
  }

  // メール本文を作成
  const mailBody = formatMailBody(senderId, name, phone, state);

  console.log("[EMAIL] 送信開始");
  console.log("  From:", process.env.GMAIL_USER);
  console.log("  To:", toAddresses);

  await transporter.sendMail({
    from: process.env.GMAIL_USER,
    to: toAddresses,
    subject: "Facebook Messenger問い合わせ【AGAクリニック比較サイト】aga_facebook",
    text: mailBody,
  });

  console.log("[EMAIL] 送信成功");
}

// メール本文のフォーマット
function formatMailBody(
  senderId: string,
  name: string,
  phone: string,
  state: UserState | undefined
): string {
  let body = `Facebook Messenger問い合わせ\n\n`;
  body += `[送信者ID] ${senderId}\n`;
  body += `[お名前] ${name}\n`;
  body += `[電話番号] ${phone}\n\n`;

  if (state?.answers) {
    body += `=== 診断結果 ===\n`;
    
    if (state.answers.q1) body += `質問1: ${getAnswerText(state.answers.q1)}\n`;
    if (state.answers.q2) body += `質問2: ${getAnswerText(state.answers.q2)}\n`;
    if (state.answers.q3) body += `質問3: ${getAnswerText(state.answers.q3)}\n`;
    if (state.answers.q4) body += `質問4: ${getAnswerText(state.answers.q4)}\n`;
    if (state.answers.q5) body += `質問5: ${getAnswerText(state.answers.q5)}\n`;
    if (state.answers.q6) body += `質問6: ${getAnswerText(state.answers.q6)}\n`;
  }

  return body;
}

// 回答のpayloadを読みやすいテキストに変換
function getAnswerText(payload: string): string {
  const answerMap: { [key: string]: string } = {
    // 質問1
    "Q1_A": "生え際が少し後退してきた気がする",
    "Q1_B": "頭頂部の地肌が透けて見えることがある",
    "Q1_C": "後頭部のボリュームが減った気がする",
    // 質問2
    "Q2_A": "数カ月くらい悩んでいる",
    "Q2_B": "半年～1年くらい悩んでいる",
    "Q2_C": "1年以上悩んでいる",
    // 質問3
    "Q3_A": "鏡や写真を見たときに意識する",
    "Q3_B": "人に会うときに意識する",
    "Q3_C": "抜け毛を見たときに意識する",
    // 質問4
    "Q4_A": "将来、手遅れにならないか不安",
    "Q4_B": "印象が悪くなりそうで不安",
    "Q4_C": "自信が持てなくなりそう",
    // 質問5
    "Q5_A": "現在、AGA治療薬使っている",
    "Q5_B": "過去にAGA治療薬を使っていた",
    "Q5_C": "AGA治療薬を使ったことはない",
    // 質問6
    "Q6_PRIVACY": "【重視】周りに知られずに治療できる",
    "Q6_EFFECT": "【重視】効果をしっかり実感したい",
    "Q6_PRICE": "【重視】無理なく続けられる価格",
  };

  return answerMap[payload] || payload;
}

// ===== Send API =====

// Send API: ボタンテンプレートを送信
async function sendButtonTemplate(recipientId: string, text: string, buttons: Array<{title: string, payload: string}>) {
  try {
    const response = await fetch(FB_GRAPH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "button",
              text: text || "選択してください",
              buttons: buttons.map(btn => ({
                type: "postback",
                title: btn.title,
                payload: btn.payload
              }))
            },
          },
        },
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    });

    const data = await response.json();
    
    if (!response.ok) {
      console.error(`[ERROR] ボタン送信失敗: ${response.status}`, data);
    }

    return data;
  } catch (error) {
    console.error("[ERROR] ボタン送信エラー:", error);
    throw error;
  }
}

// Send API: 画像のみ（結果のヒーロー画像など）
async function sendImageMessage(recipientId: string, imageUrl: string) {
  try {
    const response = await fetch(FB_GRAPH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: "image",
            payload: { url: imageUrl, is_reusable: true },
          },
        },
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`[ERROR] 画像送信失敗: ${response.status}`, data);
    }

    return data;
  } catch (error) {
    console.error("[ERROR] 画像送信エラー:", error);
    throw error;
  }
}

// Send API: ジェネリックテンプレート（1要素・画像＋最大3ボタン）
async function sendGenericTemplate(
  recipientId: string,
  element: {
    image_url: string;
    title: string;
    subtitle?: string;
    buttons: Array<{ title: string; payload: string }>;
  }
) {
  try {
    const el: Record<string, unknown> = {
      title: truncateForMessenger(element.title, 80),
      image_url: element.image_url,
      buttons: element.buttons.map((btn) => ({
        type: "postback",
        title: truncateForMessenger(btn.title, 20),
        payload: btn.payload,
      })),
    };
    if (element.subtitle?.trim()) {
      el.subtitle = truncateForMessenger(element.subtitle, 80);
    }

    const response = await fetch(FB_GRAPH_API_URL, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        recipient: { id: recipientId },
        message: {
          attachment: {
            type: "template",
            payload: {
              template_type: "generic",
              elements: [el],
            },
          },
        },
        access_token: FB_PAGE_ACCESS_TOKEN,
      }),
    });

    const data = await response.json();

    if (!response.ok) {
      console.error(`[ERROR] ジェネリックテンプレート送信失敗: ${response.status}`, data);
    }

    return data;
  } catch (error) {
    console.error("[ERROR] ジェネリックテンプレート送信エラー:", error);
    throw error;
  }
}

/** 画像 URL があればジェネリック、なければ従来のボタンテンプレート */
async function sendInteractiveCard(
  recipientId: string,
  args: {
    title: string;
    subtitle?: string;
    imageUrl?: string;
    buttons: Array<{ title: string; payload: string }>;
  }
) {
  if (args.imageUrl) {
    await sendGenericTemplate(recipientId, {
      image_url: args.imageUrl,
      title: args.title,
      ...(args.subtitle !== undefined && args.subtitle.trim() !== ""
        ? { subtitle: args.subtitle }
        : {}),
      buttons: args.buttons,
    });
  } else {
    const text =
      args.subtitle?.trim() ? `${args.title}\n\n${args.subtitle}` : args.title;
    await sendButtonTemplate(recipientId, text, args.buttons);
  }
}

// リクエスト署名の検証
function verifyRequestSignature(req: any, res: any, buf: Buffer) {
  const signature = req.headers["x-hub-signature-256"];
  
  if (!signature) {
    console.warn("⚠ 署名ヘッダーがありません");
    return;
  }

  if (!FB_APP_SECRET) {
    console.error("✗ FB_APP_SECRETが設定されていません");
    throw new Error("FB_APP_SECRETが設定されていません");
  }

  const elements = signature.split("=");
  const signatureHash = elements[1];
  const expectedHash = crypto
    .createHmac("sha256", FB_APP_SECRET)
    .update(buf)
    .digest("hex");

  if (signatureHash !== expectedHash) {
    console.error("✗ リクエスト署名の検証に失敗しました");
    console.error("受信した署名:", signatureHash);
    console.error("期待される署名:", expectedHash);
    throw new Error("リクエスト署名の検証に失敗しました");
  }

  console.log("✓ リクエスト署名の検証成功");
}

// サーバー起動
const port = Number(process.env.PORT || 8080);
app.listen(port, () => {
  console.log("=================================");
  console.log("Facebook Messenger Bot - Test Mode");
  console.log(`Listening on http://localhost:${port}`);
  console.log("=================================");
});
