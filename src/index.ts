import { XMLParser } from "fast-xml-parser";

export interface Env {
  D1: D1Database;
  KV: KVNamespace;
  WEIXIN_APP_ID: string;
  WEIXIN_SECRET: string;
  OPENAI_API_KEY: string;
}

type WeixinBaseMessage = {
  FromUserName: string;
  CreateTime: string;
};

type WeixinTextMessage = WeixinBaseMessage & {
  MsgType: "text";
  Content: string;
};

type WeixinEventMessage = WeixinBaseMessage & {
  MsgType: "event";
  Event: string;
};

type WeixinMessage = WeixinTextMessage | WeixinEventMessage;

type ChatGPTMessage = {
  role: string;
  content: string;
};

type Command = {
  func: (context: Context) => Promise<void>;
  desc: string;
};

const WEIXIN_ACCESS_TOKEN_KEY = "weixin_access_token";

class BaseContext {
  env: Env;
  openId: string;
  private _weixinAccessTokenPromise: Promise<string | null> | null = null;

  constructor(env: Env, openId: string) {
    this.env = env;
    this.openId = openId;
  }

  async weixinAccessToken() {
    if (!this._weixinAccessTokenPromise) {
      this._weixinAccessTokenPromise = this.env.KV.get(WEIXIN_ACCESS_TOKEN_KEY);
    }

    return this._weixinAccessTokenPromise;
  }
}

class Context extends BaseContext {
  weixinMessage: WeixinMessage;

  constructor(env: Env, weixinMessage: WeixinMessage) {
    super(env, weixinMessage.FromUserName);
    this.weixinMessage = weixinMessage;
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

const postWeixin = async (
  context: BaseContext,
  url: string,
  body: BodyInit
) => {
  const u = new URL(url);
  const weixinAccessToken = await context.weixinAccessToken();
  u.searchParams.set("access_token", weixinAccessToken ?? "");
  return fetch(u, {
    body,
    method: "POST",
    headers:
      typeof body === "string"
        ? {
            "content-type": "application/json;charset=UTF-8",
          }
        : undefined,
  });
};

const setWeixinTyping = async (context: BaseContext) => {
  const { openId } = context;
  await postWeixin(
    context,
    "https://api.weixin.qq.com/cgi-bin/message/custom/typing",
    JSON.stringify({
      touser: openId,
      command: "Typing",
    })
  );

  setTimeout(() => {
    setWeixinTyping(context);
  }, 15_000);
};

const sendWeixinTextMessage = async (context: BaseContext, content: string) => {
  const { openId } = context;
  const resp = await postWeixin(
    context,
    "https://api.weixin.qq.com/cgi-bin/message/custom/send",
    JSON.stringify({
      touser: openId,
      msgtype: "text",
      text: {
        content,
      },
    })
  );

  const { errcode }: { errcode: number } = await resp.json();
  if (errcode === 45002) {
    const step = Math.min(500, Math.ceil(content.length / 2));
    for (let i = 0; i < content.length; i += step) {
      await sendWeixinTextMessage(context, content.substring(i, i + step));
    }
  }
};

const sendWeixinImageMessage = async (
  context: BaseContext,
  mediaId: string
) => {
  const { openId } = context;
  await postWeixin(
    context,
    "https://api.weixin.qq.com/cgi-bin/message/custom/send",
    JSON.stringify({
      touser: openId,
      msgtype: "image",
      image: {
        media_id: mediaId,
      },
    })
  );
};

const sendSystemMessage = async (context: BaseContext, content: string) => {
  await sendWeixinTextMessage(
    context,
    `[系统消息]
----------------
${content}`
  );
};

const sendChatGPTMessage = async (context: BaseContext, content: string) => {
  await sendWeixinTextMessage(context, content);
};

const sendTimedoutMessage = (context: BaseContext, message: string) => {
  return setTimeout(() => {
    sendSystemMessage(context, message);
  }, 20_000);
};

const postOpenAI = async (env: Env, url: string, body: BodyInit) => {
  return fetch(url, {
    body,
    method: "POST",
    headers: {
      "content-type": "application/json;charset=UTF-8",
      Authorization: `Bearer ${env.OPENAI_API_KEY}`,
    },
  });
};

const callChatGPT = async (env: Env, messages: ChatGPTMessage[] = []) => {
  const resp = await postOpenAI(
    env,
    "https://api.openai.com/v1/chat/completions",
    JSON.stringify({
      model: "gpt-3.5-turbo",
      messages,
      temperature: 1.0,
    })
  );

  const data: {
    choices: { message: { content: string } }[];
  } = await resp.json();
  return data.choices[0].message.content;
};

const callDALLE = async (context: BaseContext, prompt: string) => {
  const { env } = context;
  const resp = await postOpenAI(
    env,
    "https://api.openai.com/v1/images/generations",
    JSON.stringify({
      prompt,
    })
  );

  const data: {
    data: { url: string }[];
    error?: {
      message: string;
    };
  } = await resp.json();
  if (data.error) {
    await sendSystemMessage(
      context,
      `DALL·E 调用失败，错误信息为：${data.error.message}`
    );
    return;
  }
  return data.data[0].url;
};

const sendImage = async (context: Context, url: string) => {
  const form = new FormData();
  const image = await (await fetch(url)).blob();
  form.append("media", image, "image.png");

  const resp = await postWeixin(
    context,
    `https://api.weixin.qq.com/cgi-bin/media/upload?type=image`,
    form
  );

  const { media_id }: { media_id: string } = await resp.json();
  await sendWeixinImageMessage(context, media_id);
};

const commonReply = async (context: Context) => {
  const { weixinMessage } = context;
  if (weixinMessage.MsgType === "event") {
    if (weixinMessage.Event === "subscribe") {
      await sendSystemMessage(context, "感谢关注！");
    }
    return true;
  }

  if (weixinMessage.MsgType !== "text") {
    await sendSystemMessage(context, "非常抱歉，目前仅支持文本消息");
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

    await sendSystemMessage(context, commandsDesc);
  },
  desc: "/help，查看所有命令",
};

const initCommand: Command = {
  func: async (context) => {
    if (context.weixinMessage.MsgType !== "text") return;

    const { env, openId, weixinMessage } = context;
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
      await sendSystemMessage(context, "设置失败");
      return;
    }

    try {
      await env.D1.prepare(
        "INSERT INTO UserSettings (openId, createdAt) VALUES (?1, ?2)"
      )
        .bind(openId, Math.ceil(Date.now() / 1000))
        .run();
    } catch (e) {}

    try {
      await env.D1.prepare(
        `UPDATE UserSettings SET ${field}=?2 WHERE openId=?1`
      )
        .bind(openId, value)
        .run();
      await sendSystemMessage(context, "设置成功");
    } catch (e) {
      await sendSystemMessage(context, "设置失败");
    }
  },
  desc: `/init role <system | user>，设置初始化角色
/init content <初始化消息>，设置初始化消息`,
};

const imageCommand: Command = {
  func: async (context) => {
    if (context.weixinMessage.MsgType !== "text") return;

    const { env, openId, weixinMessage } = context;
    const prompt = weixinMessage.Content.substring(7);

    const timer = sendTimedoutMessage(
      context,
      "DALL·E 接口有可能超时，若未回复请稍后再试"
    );
    const url = await callDALLE(context, prompt);
    clearTimeout(timer);

    if (!url) return;
    await Promise.all([
      env.D1.prepare(
        "INSERT INTO Images (openId, prompt, url, createdAt) VALUES (?1, ?2, ?3, ?4)"
      )
        .bind(openId, prompt, url, Math.ceil(Date.now() / 1000))
        .run(),
      sendSystemMessage(context, `图片生成成功，url 为 ${url}`),
      sendImage(context, url),
    ]);

    return;
  },
  desc: `/image <图片描述>，DALL·E 生成图片`,
};

const commands: Command[] = [helpCommand, initCommand, imageCommand];

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

  if (weixinMessage.Content.startsWith("/image ")) {
    await imageCommand.func(context);
    return true;
  }

  return false;
};

const chatGPTReply = async (context: Context) => {
  const { env, openId, weixinMessage } = context;
  if (weixinMessage.MsgType !== "text") return false;
  setWeixinTyping(context);

  const initMessagePromise = env.D1.prepare(
    "SELECT initMessageRole AS role, initMessageContent AS content FROM UserSettings WHERE openId = ?1"
  )
    .bind(openId)
    .first<{
      role?: string;
      content?: string;
    } | null>();

  const previousMessagesPromise = env.D1.prepare(
    "SELECT content, role FROM Messages WHERE openId = ?1 AND datetime(createdAt, 'unixepoch') >= datetime('now', '-3 minutes') ORDER BY id DESC LIMIT 6"
  )
    .bind(openId)
    .all<ChatGPTMessage>();

  const initMessage = await initMessagePromise;
  const { results: previousMessages = [] } = await previousMessagesPromise;

  const timer = sendTimedoutMessage(
    context,
    "ChatGPT 接口有可能超时，若未回复请稍后再试"
  );
  const content = await callChatGPT(env, [
    {
      role: initMessage?.role ?? "system",
      content: initMessage?.content ?? "你是一个没有感情的聊天机器人",
    },
    ...previousMessages.reverse(),
    { role: "user", content: weixinMessage.Content },
  ]);
  clearTimeout(timer);

  await Promise.all([
    env.D1.prepare(
      "INSERT INTO Messages (openId, content, role, createdAt) VALUES (?1, ?2, 'user', ?3), (?1, ?4, 'assistant', ?5)"
    )
      .bind(
        openId,
        weixinMessage.Content,
        weixinMessage.CreateTime,
        content,
        Math.ceil(Date.now() / 1000)
      )
      .run(),
    sendChatGPTMessage(context, content),
  ]);
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
    ctx.waitUntil(replyUser(new Context(env, weixinMessage)));
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
