import { XMLParser } from "fast-xml-parser";

export interface Env {
  D1: D1Database;
  KV: KVNamespace;
  WEIXIN_APP_ID: string;
  WEIXIN_SECRET: string;
  CHATGPT_API_KEY: string;
}

type WeixinBaseMessage = {
  FromUserName: string;
  CreateTime: string;
};

type WeixinUserMessage = WeixinBaseMessage & {
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

type WeixinEventMessage = WeixinBaseMessage & {
  MsgType: "event";
  Event: string;
};

type WeixinMessage = WeixinUserMessage | WeixinEventMessage;

type ChatGPTMessage = {
  role: string;
  content: string;
};

type Command = {
  func: (context: Context) => Promise<void>;
  desc: string;
};

const WEIXIN_ACCESS_TOKEN_KEY = "weixin_access_token";

class Context {
  env: Env;
  weixinMessage: WeixinMessage;
  private _weixinAccessTokenPromise: Promise<string | null> | null = null;

  constructor(env: Env, weixinMessage: WeixinMessage) {
    this.env = env;
    this.weixinMessage = weixinMessage;
  }

  async weixinAccessToken() {
    if (!this._weixinAccessTokenPromise) {
      this._weixinAccessTokenPromise = this.env.KV.get(WEIXIN_ACCESS_TOKEN_KEY);
    }

    return this._weixinAccessTokenPromise;
  }
}

const getWeixinAccessToken = async (env: Env) => {
  const resp = await fetch(
    `https://api.weixin.qq.com/cgi-bin/token?grant_type=client_credential&appid=${env.WEIXIN_APP_ID}&secret=${env.WEIXIN_SECRET}`
  );
  const {
    access_token,
  }: {
    access_token: string;
  } = await resp.json();
  return access_token;
};

const setWeixinTyping = async (context: Context) => {
  const { weixinMessage } = context;
  const weixinAccessToken = await context.weixinAccessToken();
  await fetch(
    `https://api.weixin.qq.com/cgi-bin/message/custom/typing?access_token=${weixinAccessToken}`,
    {
      body: JSON.stringify({
        touser: weixinMessage.FromUserName,
        command: "Typing",
      }),
      method: "POST",
      headers: {
        "content-type": "application/json;charset=UTF-8",
      },
    }
  );

  setTimeout(() => {
    setWeixinTyping(context);
  }, 15_000);
};

const sendWeixinMessage = async (context: Context, content: string) => {
  const { weixinMessage } = context;
  const weixinAccessToken = await context.weixinAccessToken();
  const resp = await fetch(
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

  const { errcode }: { errcode: number } = await resp.json();
  if (errcode === 45002) {
    const step = Math.min(500, Math.ceil(content.length / 2));
    for (let i = 0; i < content.length; i += step) {
      await sendWeixinMessage(context, content.substring(i, i + step));
    }
  }
};

const callChatGPT = async (
  env: Env,
  content: string,
  initMessage: ChatGPTMessage,
  previousMessages: ChatGPTMessage[] = []
) => {
  const messages: ChatGPTMessage[] = [
    initMessage,
    ...previousMessages.reverse(),
    { role: "user", content },
  ];
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
  const data: {
    choices: { message: { content: string } }[];
  } = await resp.json();
  return data.choices[0].message.content;
};

const commonReply = async (context: Context) => {
  const { weixinMessage } = context;
  if (weixinMessage.MsgType === "event") {
    if (weixinMessage.Event === "subscribe") {
      await sendWeixinMessage(context, "感谢关注！");
    }
    return true;
  }

  if (weixinMessage.MsgType !== "text") {
    await sendWeixinMessage(context, "非常抱歉，目前仅支持文本消息");
    return true;
  }

  return false;
};

const helpCommand: Command = {
  func: async (context) => {
    let commandsDesc = "";

    for (let i = 0; i < commands.length; i++) {
      if (i === 0) {
        commandsDesc += commands[i].desc;
      } else {
        commandsDesc += "\n\n" + commands[i].desc;
      }
    }

    await sendWeixinMessage(context, commandsDesc);
  },
  desc: "/help，查看所有命令",
};

const initCommand: Command = {
  func: async (context) => {
    if (context.weixinMessage.MsgType !== "text") return;

    const { env, weixinMessage } = context;
    const subCommand = weixinMessage.Content.substring(6);

    let field = "";
    let value = "";
    if (subCommand.startsWith("role ")) {
      field = "initMessageRole";
      value = subCommand.substring(5);
    } else if (subCommand.startsWith("content ")) {
      field = "initMessageContent";
      value = subCommand.substring(8);
    } else {
      await sendWeixinMessage(context, "设置失败");
      return;
    }

    try {
      await env.D1.prepare(
        "INSERT INTO UserSettings (openId, createdAt) VALUES (?1, ?2)"
      )
        .bind(weixinMessage.FromUserName, Math.ceil(Date.now() / 1000))
        .run();
    } catch (e) {}

    try {
      await env.D1.prepare(
        `UPDATE UserSettings SET ${field}=?2 WHERE openId=?1`
      )
        .bind(weixinMessage.FromUserName, value)
        .run();
      await sendWeixinMessage(context, "设置成功");
    } catch (e) {
      await sendWeixinMessage(context, "设置失败");
    }
  },
  desc: `/init role <system | user>，设置初始化角色
/init content <初始化消息>，设置初始化消息`,
};

const commands: Command[] = [helpCommand, initCommand];

const commandReply = async (context: Context) => {
  const { weixinMessage } = context;
  if (weixinMessage.MsgType !== "text") return false;

  if (weixinMessage.Content.startsWith("/help")) {
    await helpCommand.func(context);
    return true;
  }

  if (weixinMessage.Content.startsWith("/init ")) {
    await initCommand.func(context);
    return true;
  }
  return false;
};

const chatGPTReply = async (context: Context) => {
  const { env, weixinMessage } = context;
  if (weixinMessage.MsgType !== "text") return false;
  setWeixinTyping(context);

  const initMessage = await env.D1.prepare(
    "SELECT initMessageRole AS role, initMessageContent AS content FROM UserSettings WHERE openId = ?1"
  )
    .bind(weixinMessage.FromUserName)
    .first<{
      role?: string;
      content?: string;
    } | null>();

  const { results } = await env.D1.prepare(
    "SELECT content, role FROM Messages WHERE openId = ?1 AND datetime(createdAt, 'unixepoch') >= datetime('now', '-3 minutes') ORDER BY id DESC LIMIT 6"
  )
    .bind(weixinMessage.FromUserName)
    .all<ChatGPTMessage>();

  const content = await callChatGPT(
    env,
    weixinMessage.Content,
    {
      role: initMessage?.role ?? "system",
      content: initMessage?.content ?? "你是一个没有感情的聊天机器人",
    },
    results
  );

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

  await sendWeixinMessage(context, content);
  return true;
};

const replyUser = async (context: Context) => {
  const replyFunctions = [commonReply, commandReply, chatGPTReply];
  for (const replyFunction of replyFunctions) {
    if (await replyFunction(context)) break;
  }
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

    const context = new Context(env, weixinMessage);
    ctx.waitUntil(replyUser(context));

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
