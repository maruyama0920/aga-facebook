import "dotenv/config";
import express from "express";
import crypto from "crypto";
import fetch from "node-fetch";
// 設定
const FB_PAGE_ACCESS_TOKEN = process.env.FB_PAGE_ACCESS_TOKEN;
const FB_VERIFY_TOKEN = process.env.FB_VERIFY_TOKEN;
const FB_APP_SECRET = process.env.FB_APP_SECRET;
const SKIP_SIGNATURE_VERIFICATION = process.env.SKIP_SIGNATURE_VERIFICATION === "true";
// Facebook Graph API URL
const FB_GRAPH_API_URL = "https://graph.facebook.com/v21.0/me/messages";
// Expressサーバーの設定
const app = express();
if (SKIP_SIGNATURE_VERIFICATION) {
    console.log("⚠ 警告: 署名検証をスキップします（テストモード）");
    app.use(express.json());
}
else {
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
    }
    else {
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
    }
    else {
        console.log("✗ ページイベントではありません");
        res.sendStatus(404);
    }
});
// Webhookイベントの分岐処理
async function handleWebhookEvent(event) {
    console.log("\n--- Event変数の内容 ---");
    console.log(JSON.stringify(event, null, 2));
    const senderId = event.sender?.id;
    console.log("\n--- Messaging Event ---");
    console.log("送信者ID:", senderId);
    console.log("受信者ID:", event.recipient?.id);
    console.log("タイムスタンプ:", new Date(event.timestamp).toISOString());
    if (!senderId) {
        console.log("✗ 送信者IDが見つかりません");
        return;
    }
    // 1. メッセージイベント
    if (event.message) {
        console.log("\n[イベントタイプ: MESSAGE]");
        await handleMessage(senderId, event.message);
    }
    // 2. ポストバックイベント（ボタンクリックなど）
    else if (event.postback) {
        console.log("\n[イベントタイプ: POSTBACK]");
        await handlePostback(senderId, event.postback);
    }
    // 3. リファラルイベント（広告からの流入など）
    else if (event.referral) {
        console.log("\n[イベントタイプ: REFERRAL]");
        await handleReferral(senderId, event.referral);
    }
    // 4. 配信確認
    else if (event.delivery) {
        console.log("\n[イベントタイプ: DELIVERY]");
        console.log("配信済みメッセージID:", event.delivery.mids);
    }
    // 5. 既読確認
    else if (event.read) {
        console.log("\n[イベントタイプ: READ]");
        console.log("既読ウォーターマーク:", event.read.watermark);
    }
    // 6. その他
    else {
        console.log("\n[イベントタイプ: UNKNOWN]");
        console.log("イベント内容:", JSON.stringify(event, null, 2));
    }
}
// メッセージイベントの処理
async function handleMessage(senderId, message) {
    console.log("メッセージID:", message.mid);
    console.log("テキスト:", message.text);
    console.log("添付ファイル:", message.attachments);
    const text = message.text;
    if (!text) {
        console.log("テキストメッセージではありません");
        return;
    }
    // 「ボタン」と送信された場合
    if (text === "ボタン") {
        await sendButtonTemplate(senderId);
        return;
    }
    // テスト: オウム返し
    await sendTextMessage(senderId, `受信しました: ${text}`);
}
// ポストバックイベントの処理
async function handlePostback(senderId, postback) {
    console.log("Payload:", postback.payload);
    console.log("Title:", postback.title);
    const payload = postback.payload;
    // テスト: ペイロードに応じた返信
    await sendTextMessage(senderId, `ボタンをクリックしました: ${payload}`);
}
// リファラルイベントの処理
async function handleReferral(senderId, referral) {
    console.log("Ref:", referral.ref);
    console.log("Source:", referral.source);
    console.log("Type:", referral.type);
    // テスト: リファラル情報を返信
    await sendTextMessage(senderId, `ようこそ！（参照元: ${referral.source}）`);
}
// Send API: テキストメッセージを送信
async function sendTextMessage(recipientId, text) {
    console.log("\n>>> メッセージ送信開始");
    console.log("宛先:", recipientId);
    console.log("内容:", text);
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
        if (response.ok) {
            console.log("✓ メッセージ送信成功");
            console.log("レスポンス:", data);
        }
        else {
            console.error("✗ メッセージ送信失敗");
            console.error("ステータス:", response.status);
            console.error("エラー:", data);
        }
        return data;
    }
    catch (error) {
        console.error("✗ メッセージ送信エラー:", error);
        throw error;
    }
}
// Send API: ボタンテンプレートを送信
async function sendButtonTemplate(recipientId) {
    console.log("\n>>> ボタンテンプレート送信開始");
    console.log("宛先:", recipientId);
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
                            text: "ボタンのテストです。選択してください：",
                            buttons: [
                                {
                                    type: "postback",
                                    title: "オプション1",
                                    payload: "OPTION_1",
                                },
                                {
                                    type: "postback",
                                    title: "オプション2",
                                    payload: "OPTION_2",
                                },
                                {
                                    type: "postback",
                                    title: "キャンセル",
                                    payload: "CANCEL",
                                },
                            ],
                        },
                    },
                },
                access_token: FB_PAGE_ACCESS_TOKEN,
            }),
        });
        const data = await response.json();
        if (response.ok) {
            console.log("✓ ボタンテンプレート送信成功");
            console.log("レスポンス:", data);
        }
        else {
            console.error("✗ ボタンテンプレート送信失敗");
            console.error("ステータス:", response.status);
            console.error("エラー:", data);
        }
        return data;
    }
    catch (error) {
        console.error("✗ ボタンテンプレート送信エラー:", error);
        throw error;
    }
}
// リクエスト署名の検証
function verifyRequestSignature(req, res, buf) {
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
//# sourceMappingURL=index.js.map