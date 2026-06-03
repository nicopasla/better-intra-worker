export interface Env {
  BETTER_INTRA_KV: KVNamespace;
  CLIENT_ID: string;
  CLIENT_SECRET: string;
}

export type UserData = {
  sessionTokens?: string[];
  settings?: Record<string, any>;
  intra?: {
    accessToken: string;
    refreshToken?: string;
    expiresAt?: number;
  };
};

