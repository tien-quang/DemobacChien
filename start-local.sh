#!/usr/bin/env bash
# Chạy toàn bộ trên máy bạn (Linux/Mac): ONLYOFFICE (Docker) + ứng dụng Node. Dữ liệu nằm trong server/data.
set -e
cd "$(dirname "$0")"
if [ ! -f .env ]; then
  secret=$(node -e "console.log(require('crypto').randomBytes(32).toString('hex'))")
  sed "s/doi-thanh-chuoi-ngau-nhien-dai/$secret/" .env.example > .env
  echo "Đã tạo .env với JWT secret ngẫu nhiên."
fi
docker compose --env-file .env up -d
set -a; . ./.env; set +a
npm run build
npm start
