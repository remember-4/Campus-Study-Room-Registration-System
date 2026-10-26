# Campus Rooms — 校园自习室预约系统初稿

Node.js 24 + Express + PostgreSQL。无需 Flask、MySQL 或单独部署前端。

## 已包含

- 邮箱注册、登录、退出；密码以 bcrypt 哈希保存，登录会话保存在数据库。
- 按楼宇、人数、日期、时间查询房间；6 个示例房间、3 栋示例楼宇。
- 预约、个人预约记录、取消尚未开始的预约。
- 最长 4 小时、未来 30 天内、开放时间校验；房间与学生自身都不能重复预约。
- 管理员新增房间、调整开放时间、隐藏房间；有预约冲突时拒绝管理变更。
- 近 30 天统计，使用 JOIN、COUNT、SUM。
- 自动建表；不覆盖现有用户和预约。适配手机和桌面。
- 参数化 SQL、CSRF 校验、登录限流、HttpOnly 会话 Cookie。

界面使用英文，适合 CPS3740 项目展示。全站以 `CAMPUS_TIMEZONE` 为校区时间，不跟随访问者浏览器时间。

## 最简单的 Render 部署方法：Blueprint

1. 在 GitHub 创建一个仓库，将**本文件所在目录的全部内容**上传到仓库根目录。根目录应直接包含 `package.json`、`package-lock.json`、`server.js`、`render.yaml` 等文件，不要只上传 public 文件夹，也不要上传 node_modules 或 .env。
2. 登录 Render，选择 **New → Blueprint**，连接该仓库。
3. Render 读取 `render.yaml`，将创建一个 Node Web Service 和一个 PostgreSQL 数据库，默认区域均为 Oregon。查看页面显示的费用后再创建。
4. 在待填写的环境变量中设置：
   - `ADMIN_EMAIL`：你的管理员邮箱（可以是用于登录的邮箱，不会发邮件）。
   - `ADMIN_PASSWORD`：自行设置一个至少 12 字符的强密码，不要使用示例密码。
5. 确认部署。配置文件会自动把数据库内部连接地址填入 `DATABASE_URL`，不用手工复制。
6. 部署完成后，打开 Web Service 的 `https://你的服务名.onrender.com`。用上述管理员账号登录可看到 **Management**。

免费 PostgreSQL 当前创建后 30 天到期，不适合长期保存正式数据；持续使用请在到期前升级、备份或迁移。免费 Web Service 可能空闲休眠，首次打开需要等待唤醒。Render 的方案是否可用、是否收费以创建页面为准；不要把正式预约信息长期保存在会到期的数据库中。

## 手动创建数据库和网站（如果不使用 Blueprint）

### 1. 创建数据库

Render 控制台 → **New → Postgres**：

- Name：`campus-rooms-db`
- Database：`campus_rooms`
- Region：选择一个区域，之后网站选择同一区域
- Plan：短期演示可选择可用的免费方案；长期用付费方案

创建并等待数据库可用，在数据库页面的连接信息中复制 **Internal Database URL**。这是完整连接字符串，包含密码，请勿放进前端代码、GitHub 或聊天。

### 2. 创建网站

Render 控制台 → **New → Web Service** → 连接上传源码的 GitHub 仓库：

| 设置 | 值 |
| --- | --- |
| Language / Runtime | Node |
| Region | 与数据库一致 |
| Root Directory | 仓库根目录已有 package.json 时留空 |
| Build Command | `npm ci --omit=dev` |
| Start Command | `npm start` |
| Health Check Path | `/api/health` |

在 **Environment** 中添加：

| 变量名 | 内容 |
| --- | --- |
| `DATABASE_URL` | 前面复制的 Internal Database URL |
| `NODE_ENV` | `production` |
| `ADMIN_EMAIL` | 你的管理员邮箱 |
| `ADMIN_PASSWORD` | 自设至少 12 字符的密码 |
| `CAMPUS_TIMEZONE` | `America/New_York`，或校区实际时区，例如 `Asia/Shanghai` |

保存部署。第一次启动自动建表、插入示例楼宇与房间、创建管理员。后续部署不会清空预约。

管理员环境变量仅在该邮箱还没有账号时创建管理员；它们不会重置现有密码，也不会将已有学生自动提升为管理员。请在开放注册之前先配置管理员。之后可以删除 `ADMIN_PASSWORD` 环境变量再重新部署；数据库内的账号仍然保留。

## 本地运行

安装 Node.js 24 和 PostgreSQL；先新建空数据库 `campus_rooms`。

```powershell
npm ci
Copy-Item .env.example .env
# 编辑 .env 中的 DATABASE_URL、ADMIN_EMAIL 和 ADMIN_PASSWORD
npm start
```

打开 http://localhost:3000 。本地不要设 `NODE_ENV=production`，因为开发环境 HTTP 不能使用生产环境的安全 Cookie。

```powershell
npm test
```

测试用 PGlite（嵌入式 PostgreSQL）运行真实 SQL，覆盖预约、冲突、权限、取消、非法日期、管理员与数据库会话。PGlite 测试只有单连接，无法验证真实 PostgreSQL 多连接竞争；实际部署后还应使用两个账号同时预约同一房间，确认只有一个成功。应用在 READ COMMITTED 事务中按固定顺序锁定用户和房间，以串行化竞争预约。初始化使用 PostgreSQL 事务级 advisory lock；测试适配器省略此初始化锁。

## 数据库设计

五张业务/支撑表：`users`、`buildings`、`rooms`、`reservations`、`sessions`。关系：Building→Rooms，User→Reservations，Room→Reservations，User→Sessions。完整表结构见 `schema.sql`。

学生无法自选管理员角色。数据库只在服务端访问。若采用外部数据库，使用提供方要求的 TLS 连接字符串，不要通过关闭证书校验来绕过错误。Render 内部连接使用内部 URL。

## 初稿边界

这是可部署的课程项目初稿，不含邮件验证、忘记密码、SSO、预约审批和自动备份。样例楼宇和房间不是学校真实库存。取消规则为预约开始前；报表按近 30 天内已开始的有效预约统计，不是实时占用率。管理员不能隐藏有未结束预约的房间，也不能把开放时间改成与现有未结束预约冲突；暂不提供管理员代取消功能。开放时间限定同日，不支持跨午夜预约。

初始结构变更使用 `CREATE TABLE IF NOT EXISTS`；后续更改已有字段需要另外编写迁移，不能仅修改建表语句。首次上线后不要随意更改校区时区，因为预约存储的是校区当地时间。夏令时切换日的重复或不存在时段尚未单独处理，若校区在实行夏令时的地区，请避免在切换时段开放预约。

提案技术选型应同步更新为 Node.js / Express / PostgreSQL。当前还没有替你在 Render 账户内创建或发布任何服务。

## 官方文档

- 创建与连接 PostgreSQL：https://render.com/docs/postgresql-creating-connecting
- 部署 Express：https://render.com/docs/deploy-node-express-app
- Blueprint：https://render.com/docs/blueprint-spec
- 免费方案限制：https://render.com/docs/free
