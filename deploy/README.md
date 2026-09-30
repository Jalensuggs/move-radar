# 部署到自己的服务器

线上（GitHub Pages）那份是[只读快照](../README.md#在线演示与部署)；这里说的是把**带后端的完整版本**跑在一台 Linux 服务器上。

## 结构

```
访客 ──HTTPS──▶ 宿主机的 Caddy ──▶ 127.0.0.1:3000 ──▶ 容器 move-radar（网页 + 调度，一个进程）
                (证书、80/443)                          └─ /data 卷：radar.db（SQLite）
```

- 只起**一个容器**，端口只绑宿主机的 `127.0.0.1`；HTTPS 由宿主机上已有的 Caddy 反代。绑成 `0.0.0.0` 会绕过 Caddy 直接暴露。
- 容器有 320 MB 内存上限，实测运行占用约 60 MB。适合和别的项目共用一台 2 GB 的机器。
- 服务器要能访问 Google News、Nasdaq、Cboe、CNN：**中国大陆的节点大概率不行，用香港 / 新加坡**（香港还不用备案）。实测阿里云香港节点上除了 FRED 都通；FRED 只用于两条现货油价，连不上时自动隐藏那两张卡片，其余不受影响。

## 部署

```bash
git clone https://github.com/Jalensuggs/move-radar.git && cd move-radar
touch .env && chmod 600 .env
docker compose up -d --build
curl -s http://127.0.0.1:3000/healthz      # {"ok":true}
```

再在 Caddy 里加一个站点块（先备份、先 `caddy validate`）：

```
move-radar.example.com {
    encode zstd gzip
    reverse_proxy 127.0.0.1:3000
}
```

域名的 A 记录要先指向服务器 IP 并生效，再 reload Caddy，否则证书申请连续失败会被 Let's Encrypt 限流。

## 更新

```bash
cd move-radar && git pull && docker compose up -d --build
```

数据在 `radar-data` 卷里，重建容器不会丢。

## 安全

| 接口 | 谁能用 |
|---|---|
| 看板、行情、热点、异动（只读） | 所有人 |
| 现场归因（要抓新闻、可能调模型） | 访客每小时全站合计 6 次、每个 IP 2 次（`PUBLIC_ATTRIBUTE_PER_HOUR`）；已归因过的直接返回，不占额度；管理员不限 |
| AI 设置（会碰 API Key）、运行状态 | 仅管理员 |

- **管理员密码**写在服务器的 `.env` 里：`ADMIN_PASSWORD=`（至少 12 位）。不设的话，远程访问完全改不了设置，宁可锁死。
- 登录后是 7 天的 HttpOnly、SameSite=Strict Cookie（走 HTTPS 时带 Secure）；连续输错 5 次锁 10 分钟。
- 改状态的请求要求 JSON + 同源，别的网站借你的浏览器发请求会被拒。
- `.env` 权限设成 600，**密钥别经过聊天记录**，在服务器上自己粘贴：

```bash
read -rs -p "粘贴后回车: " K; echo
sed -i '/^ADMIN_PASSWORD=/d' .env && echo "ADMIN_PASSWORD=$K" >> .env
unset K
docker compose up -d      # 环境变量变了，重建容器才生效
```

模型的 API Key 不用写在 `.env` 里：用管理员密码登录后，在页面右上角「AI 设置」里填，存在数据库里，页面上只显示前 3 位和后 4 位。

## 备份

```bash
docker run --rm -v move-radar_radar-data:/data -v "$PWD":/backup alpine \
  tar czf /backup/move-radar-data-$(date +%F).tar.gz -C /data .
```

备份里含数据库，**里面有你在「AI 设置」里存的 API Key**，别上传到公开的地方。丢了也不严重：行情和新闻重启后会自动重新拉，只是历史异动的归因要重做。
