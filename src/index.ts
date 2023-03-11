export interface Env {
  KV: KVNamespace;
  WEIXIN_APP_ID: string;
  WEIXIN_SECRET: string;
}

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

export default {
  async fetch(
    request: Request,
    env: Env,
    ctx: ExecutionContext
  ): Promise<Response> {
    return new Response("Hello World!");
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
