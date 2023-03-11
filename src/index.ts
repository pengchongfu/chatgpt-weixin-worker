import { XMLParser } from "fast-xml-parser";

export interface Env {
  KV: KVNamespace;
  WEIXIN_APP_ID: string;
  WEIXIN_SECRET: string;
}

type WeixinMessage = {
  FromUserName: string;
  MsgType:
    | "text"
    | "image"
    | "voice"
    | "video"
    | "shortvideo"
    | "location"
    | "link";
  Content: string;
};

type WeixinAccessTokenResponse = {
  access_token: string;
};

const WEIXIN_ACCESS_TOKEN_KEY = "weixin_access_token";

const getWeixinAccessToken = async (env: Env) => {
  const resp = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${env.WEIXIN_APP_ID}&secret=${env.WEIXIN_SECRET}`
  );
  const { access_token }: WeixinAccessTokenResponse = await resp.json();
  return access_token;
};

const sendWeixinMessage = async (
  env: Env,
  weixinMessage: WeixinMessage,
  content: string
) => {
  const weixinAccessToken = await env.KV.get(WEIXIN_ACCESS_TOKEN_KEY);
  await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/custom/send?access_token=${weixinAccessToken}`,
    {
      body: JSON.stringify({
        touser: weixinMessage.FromUserName,
        msgtype: "text",
        text: {
          content,
        },
      }),
      method: "POST",
      headers: {
        "content-type": "application/json;charset=UTF-8",
      },
    }
  );
};

const replyUser = async (env: Env, weixinMessage: WeixinMessage) => {
  if (weixinMessage.MsgType !== "text") {
    await sendWeixinMessage(env, weixinMessage, "非常抱歉，目前仅支持文本消息");
    return;
  }
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    const parser = new XMLParser();
    const weixinMessage: WeixinMessage = parser.parse(await request.text());

    ctx.waitUntil(replyUser(env, weixinMessage));

    return new Response();
  },
  async scheduled(
    controller: ScheduledController,
    env: Env,
    ctx: ExecutionContext
  ): Promise<void> {
    const weixinAccessToken = await getWeixinAccessToken(env);
    await env.KV.put(WEIXIN_ACCESS_TOKEN_KEY, weixinAccessToken);
  },
};
