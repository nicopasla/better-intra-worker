export interface Env {
  BETTER_INTRA_KV: KVNamespace;
  EVAL_KV: KVNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
  CALLBACK_URL?: string;
  TOKEN_ENCRYPTION_KEY?: string; // base64-encoded 256-bit key for AES-GCM
  DISCORD_BOT_TOKEN?: string;
}

export type UserData = {
  sessionTokens?: string[];
  settings?: Record<string, any>;
  fortyTwoToken?: string; // AES-GCM encrypted JSON: { access_token, refresh_token, expires_at }
};

