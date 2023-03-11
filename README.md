# chatgpt-weixin-worker

利用 Cloudflare worker 功能部署自己的微信接口测试号 ChatGPT 机器人

## 所用资源及相关说明

- [worker](https://developers.cloudflare.com/workers/): 接收[微信消息回调](https://developers.weixin.qq.com/doc/offiaccount/Message_Management/Receiving_standard_messages.html)，并回复用户
- [KV](https://developers.cloudflare.com/workers/learning/how-kv-works/): 定时更新[微信 access token](https://developers.weixin.qq.com/doc/offiaccount/Basic_Information/Get_access_token.html) 并保存
- [D1](https://developers.cloudflare.com/d1/): 保存消息记录用以发给 ChatGPT

## 预先准备

1. 需要拥有自己的域名并在 Cloudflare 上做 DNS 解析
1. 注册 [Cloudflare](https://www.cloudflare.com/) 账号
1. 注册 OpenAI 账号并获取 API key
1. 安装 [wrangler](https://developers.cloudflare.com/workers/wrangler/install-and-update/)
1. clone 本项目并 `npm install` 安装依赖

## 部署步骤

1. 执行 `wrangler kv:namespace create KV`，会得到对应 KV 存储的 id。替换掉 `wrangler.toml` 文件中的 `<Your KV ID>`
1. 执行 `wrangler d1 create chatgpt-weixin-worker`，会得到对应 D1 数据库的 id。替换掉 `wrangler.toml` 文件中的 `<Your d1 database id>`
1. 执行 `wrangler d1 execute chatgpt-weixin-worker --file=./schema.sql` 向 D1 数据库中创建对应的表
1. 登录[微信公众平台接口测试账号](https://mp.weixin.qq.com/debug/cgi-bin/sandbox?t=sandbox/login)，将对应的 `appID` 及 `appsecret` 填入 `wrangler.toml` 文件中的 `<Your weixin appid>` 和 `<Your weixin secret>`
1. 用 ChatGPT API key 替换掉 `wrangler.toml` 中的 `<Your chatgpt api key>`
1. 执行 `npm run deploy` 部署 worker
1. 到 Cloudflare dashboard 给 worker 配置自定义域名（因为如果是 Cloudflare 提供的 workers.dev 域名的话，腾讯云并不会发送消息回调）
1. 将该自定义域名填入 微信公众平台-接口配置信息-URL 中，Token 随意填，点击提交，提示配置成功
1. 因为配置了每 30 分钟定时更新微信 access token，所以这时未必会开始第一次执行，可临时修改 `wrangler.toml` 中的 `crons = ["*/30 * * * *"]` 为 `crons = ["*/1 * * * *"]` 并部署。成功执行第一次之后可修改回原值并再次部署
