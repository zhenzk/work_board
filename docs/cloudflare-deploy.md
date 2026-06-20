# Cloudflare 部署说明

本项目可以部署到 Cloudflare Workers + D1 + Static Assets。仓库中不会提交真实的 `wrangler.jsonc`，因为里面通常包含你的 Worker 名称和 D1 `database_id`。请使用 `wrangler.example.jsonc` 复制生成本地配置。

## 1. 准备环境

1. 安装 Node.js 18 或更高版本。
2. 注册并登录 Cloudflare 账号。
3. 在项目根目录执行：

```powershell
npm install
```

## 2. 登录 Cloudflare

```powershell
npx wrangler login
```

授权完成后回到终端。

## 3. 创建本地配置

复制脱敏模板：

```powershell
Copy-Item wrangler.example.jsonc wrangler.jsonc
Copy-Item .dev.vars.example .dev.vars
```

`wrangler.jsonc` 和 `.dev.vars` 都是本地文件，已被 `.gitignore` 忽略，不要提交。

## 4. 创建 D1 数据库

```powershell
npm run db:create
```

命令会输出类似配置：

```json
{
  "binding": "DB",
  "database_name": "your-kanban-db",
  "database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
}
```

把真实的 `database_id` 写入本地 `wrangler.jsonc`：

```json
"database_id": "xxxxxxxx-xxxx-xxxx-xxxx-xxxxxxxxxxxx"
```

如果你改了数据库名称，也要同步修改 `package.json` 里的 D1 脚本数据库名，或直接用 Wrangler 命令指定你的数据库名。

## 5. 配置密钥

生产环境必须设置：

```powershell
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_PASSWORD
```

- `JWT_SECRET`：用于签发登录 token，建议使用足够长的随机字符串。
- `ADMIN_PASSWORD`：首次初始化默认管理员 `admin` 的密码。

本地开发时编辑 `.dev.vars`：

```text
JWT_SECRET="replace-with-a-long-random-local-secret"
ADMIN_PASSWORD="replace-with-local-admin-password"
```

## 6. 本地调试

初始化本地 D1：

```powershell
npm run db:migrate:local
```

启动本地 Worker：

```powershell
npm run dev
```

浏览器打开 Wrangler 输出的地址，通常是：

```text
http://localhost:8787
```

首次访问时，系统会在数据库为空时自动创建管理员并导入 `seed-data.json`。

默认管理员：

```text
用户名：admin
密码：.dev.vars 中的 ADMIN_PASSWORD
```

如果想清空本地 D1 后重新导入：

```powershell
Remove-Item .wrangler\state\v3\d1 -Recurse -Force
npm run db:migrate:local
npm run dev
```

## 7. 部署到 Cloudflare

先迁移远端 D1：

```powershell
npm run db:migrate
```

再部署 Worker 和静态资源：

```powershell
npm run deploy
```

部署成功后终端会输出 `workers.dev` 地址。

## 8. 部署后验证

1. 打开部署地址。
2. 使用管理员登录。
3. 检查首页、项目列表、任务新增、拖拽状态、用户管理和游客只读访问。

## 9. 常见问题

### API 返回 500，提示缺少 secret

执行：

```powershell
npx wrangler secret put JWT_SECRET
npx wrangler secret put ADMIN_PASSWORD
```

本地开发则检查 `.dev.vars` 是否存在。

### API 404 或前端能打开但接口不通

检查本地 `wrangler.jsonc` 是否保留：

```json
"run_worker_first": ["/api/*"]
```

该配置保证 `/api/*` 请求先进入 Worker，其它路径走静态资源和 SPA fallback。

### D1 迁移失败

确认已经登录：

```powershell
npx wrangler whoami
```

再确认 `wrangler.jsonc` 中 D1 绑定名为 `DB`，数据库名称和 `package.json` 脚本一致。

## 10. 开源注意事项

- 提交 `wrangler.example.jsonc`，不要提交本地 `wrangler.jsonc`。
- 提交 `.dev.vars.example`，不要提交本地 `.dev.vars`。
- 不要提交 `.wrangler/`、备份 SQL、真实 token、真实密码或生产数据库导出。

## 参考文档

- Wrangler：https://developers.cloudflare.com/workers/wrangler/
- D1：https://developers.cloudflare.com/d1/
- Workers Secrets：https://developers.cloudflare.com/workers/configuration/secrets/
- Static Assets：https://developers.cloudflare.com/workers/static-assets/
