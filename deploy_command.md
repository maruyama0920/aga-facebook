### Cloud Runへデプロイ

```bash
# 方法A: ソースから直接デプロイ（env.yaml使用）
gcloud config set project facebook-inquiry

gcloud run deploy aga-facebook --source .  --region=asia-northeast1  --platform=managed  --allow-unauthenticated --env-vars-file env.yaml