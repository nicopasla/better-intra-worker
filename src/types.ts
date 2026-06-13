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
  sessionToken?: string; // legacy
  settings?: Record<string, unknown>;
  fortyTwoToken?: string; // AES-GCM encrypted JSON: { access_token, refresh_token, expires_at }
  discordId?: string;
};

export interface TokenResponse {
  access_token?: string;
  refresh_token?: string;
  expires_in?: number;
  error?: string;
  error_description?: string;
}

export interface UserResponse {
  login?: string;
}

export interface ProjectResponse {
  id: number;
  name: string;
}

export interface ScaleTeamItem {
  id: number;
  begin_at: string;
  scale?: { duration?: number };
  team?: { project_id?: number; name?: string };
  correcteds?: unknown;
  corrector?: unknown;
}

export interface FortyTwoUser {
  id: number;
  login: string;
}

export interface CursusUser {
  id: number;
  user: {
    id: number;
    login: string;
    location?: string | null;
    pool_month?: string;
    pool_year?: string;
    displayname?: string;
    image?: { link?: string; versions?: { small?: string } };
    wallet?: number;
    correction_point?: number;
  };
  level: number;
  grade?: string;
  cursus_id: number;
}

