import { XMLParser } from "fast-xml-parser";

export interface Env {
  D1: D1Database;
  KV: KVNamespace;
  WEIXIN_APP_ID: string;
  WEIXIN_SECRET: string;
  CHATGPT_API_KEY: string;
}

type WeixinMessage = {
  FromUserName: string;
  CreateTime: string;
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

type ChatGPTMessage = {
  role: string;
  content: string;
};

type ChatGPTResonse = {
  choices: { message: { content: string } }[];
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

const callChatGPT = async (
  env: Env,
  content: string,
  previousMessages: ChatGPTMessage[] = []
) => {
  const messages: ChatGPTMessage[] = [];
  messages.push({ role: "system", content: "你是一个没有感情的聊天机器人" });
  previousMessages.reverse().forEach(({ role, content }) => {
    messages.push({
      role,
      content,
    });
  });
  messages.push({ role: "user", content });

  const resp = await fetch("https://api.openai.com/v1/chat/completions", {
    body: JSON.stringify({
      model: "gpt-3.5-turbo",
      messages,
      temperature: 1.0,
    }),
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${env.CHATGPT_API_KEY}`,
    },
  });
  const data: ChatGPTResonse = await resp.json();
  return data.choices[0].message.content;
};

const replyUser = async (env: Env, weixinMessage: WeixinMessage) => {
  if (weixinMessage.MsgType !== "text") {
    await sendWeixinMessage(env, weixinMessage, "非常抱歉，目前仅支持文本消息");
    return;
  }

  const { results } = await env.D1.prepare(
    "SELECT content, role FROM Messages WHERE openId = ?1 AND datetime(createdAt, 'unixepoch') >= datetime('now', '-3 minutes') ORDER BY id DESC LIMIT 6"
  )
    .bind(weixinMessage.FromUserName)
    .all<ChatGPTMessage>();

  const content = await callChatGPT(env, weixinMessage.Content, results);

  await env.D1.prepare(
    "INSERT INTO Messages (openId, content, role, createdAt) VALUES (?1, ?2, 'user', ?3), (?1, ?4, 'assistant', ?5)"
  )
    .bind(
      weixinMessage.FromUserName,
      weixinMessage.Content,
      weixinMessage.CreateTime,
      content,
      Math.ceil(Date.now() / 1000)
    )
    .run();

  await sendWeixinMessage(env, weixinMessage, content);
};

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    // 微信接口配置信息
    if (request.method === "GET") {
      const { searchParams } = new URL(request.url);
      return new Response(searchParams.get("echostr"));
    }

    const parser = new XMLParser();
    const { xml: weixinMessage }: { xml: WeixinMessage } = parser.parse(
      await request.text()
    );

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
