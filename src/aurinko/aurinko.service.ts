import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

const AURINKO_BASE = 'https://api.aurinko.io/v1';

export interface AurinkoAccount {
  id: number;
  email: string;
  name: string;
  serviceType: string;
  active: boolean;
}

export interface AurinkoEmailAddress {
  name?: string;
  address: string;
}

export interface AurinkoMessage {
  id: string;
  threadId: string;
  internetMessageId: string;
  subject: string;
  body?: string;
  bodySnippet: string;
  from: AurinkoEmailAddress;
  to: AurinkoEmailAddress[];
  cc: AurinkoEmailAddress[];
  bcc: AurinkoEmailAddress[];
  hasAttachments: boolean;
  receivedAt: string;
  sentAt?: string;
  date?: string;
  isDraft: boolean;
  sysLabels: string[];
  attachments: {
    id: string;
    name: string;
    mimeType: string;
    size: number;
    inline: boolean;
    // Content-ID del adjunto embebido; el HTML lo referencia como src="cid:{contentId}"
    contentId?: string;
  }[];
}

export interface AurinkoOutgoingAttachment {
  name: string;
  mimeType: string;
  /** Contenido del archivo codificado en base64 */
  content: string;
  inline?: boolean;
  contentId?: string;
}

export interface SendEmailDto {
  subject: string;
  body: string;
  to: AurinkoEmailAddress[];
  cc?: AurinkoEmailAddress[];
  attachments?: AurinkoOutgoingAttachment[];
}

export type AurinkoServiceType = 'Google' | 'Office365' | 'EWS';

@Injectable()
export class AurinkoService {
  private readonly logger = new Logger(AurinkoService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly redirectUri: string;

  constructor(private readonly config: ConfigService) {
    this.clientId = config.get<string>('AURINKO_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('AURINKO_CLIENT_SECRET') ?? '';
    this.redirectUri = config.get<string>('AURINKO_REDIRECT_URI') ?? '';
  }

  /** Detecta el serviceType a partir del dominio del email */
  detectServiceType(email: string): AurinkoServiceType {
    const domain = email.split('@')[1]?.toLowerCase() ?? '';
    if (domain === 'gmail.com' || domain === 'googlemail.com') return 'Google';
    return 'Office365';
  }

  getAuthorizationUrl(state: string, serviceType: AurinkoServiceType): string {
    const params = new URLSearchParams({
      clientId: this.clientId,
      serviceType,
      scopes: 'Mail.ReadWrite Mail.Send',
      responseType: 'code',
      returnUrl: this.redirectUri,
      state,
    });
    return `${AURINKO_BASE}/auth/authorize?${params.toString()}`;
  }

  async exchangeCodeForToken(code: string): Promise<{ accountId: number; accessToken: string }> {
    const { data } = await axios.post(
      `${AURINKO_BASE}/auth/token/${code}`,
      {},
      {
        auth: { username: this.clientId, password: this.clientSecret },
      },
    );
    return { accountId: data.accountId as number, accessToken: data.accessToken as string };
  }

  // ─── Account management (basic auth con credenciales de la app) ─────

  /** Lista las cuentas ya conectadas a la app en Aurinko. */
  async listAccounts(): Promise<AurinkoAccount[]> {
    const { data } = await axios.get(`${AURINKO_BASE}/am/accounts`, {
      auth: { username: this.clientId, password: this.clientSecret },
    });
    return (data.records ?? []) as AurinkoAccount[];
  }

  /**
   * Emite un access token para una cuenta ya conectada en Aurinko,
   * sin pasar por el flujo OAuth (la autorización ya existe en Aurinko).
   */
  async getAccountToken(accountId: number): Promise<string> {
    const { data } = await axios.get(`${AURINKO_BASE}/am/accounts/${accountId}/token`, {
      auth: { username: this.clientId, password: this.clientSecret },
    });
    return data.accessToken as string;
  }

  // ─── Endpoints de la API ────────────────────────────────────────────

  private headers(token: string) {
    return { Authorization: `Bearer ${token}` };
  }

  async getAccount(token: string): Promise<AurinkoAccount> {
    const { data } = await axios.get<AurinkoAccount>(`${AURINKO_BASE}/account`, {
      headers: this.headers(token),
    });
    return data;
  }

  async getMessages(
    token: string,
    pageToken?: string,
    limit = 20,
  ): Promise<{ records: AurinkoMessage[]; nextPageToken?: string }> {
    const { data } = await axios.get(`${AURINKO_BASE}/email/messages`, {
      headers: this.headers(token),
      params: {
        ...(pageToken ? { pageToken } : {}),
        pageSize: limit,
        // Trae el cuerpo HTML completo (no solo el snippet) para conservar el
        // formato real del email. Soportado por Google y Office365.
        bodyType: 'html',
      },
    });
    return {
      records: data.records as AurinkoMessage[],
      nextPageToken: data.nextPageToken as string | undefined,
    };
  }

  async getMessageById(token: string, messageId: string): Promise<AurinkoMessage> {
    const { data } = await axios.get<AurinkoMessage>(
      `${AURINKO_BASE}/email/messages/${encodeURIComponent(messageId)}`,
      { headers: this.headers(token), params: { bodyType: 'html' } },
    );
    return data;
  }

  /**
   * Descarga el contenido binario de un adjunto de un mensaje.
   * Devuelve el buffer y el content-type reportado por Aurinko.
   */
  async getAttachment(
    token: string,
    messageId: string,
    attachmentId: string,
  ): Promise<{ content: Buffer; contentType: string }> {
    const res = await axios.get<ArrayBuffer>(
      `${AURINKO_BASE}/email/messages/${encodeURIComponent(messageId)}/attachments/${encodeURIComponent(attachmentId)}`,
      { headers: this.headers(token), responseType: 'arraybuffer' },
    );
    return {
      content: Buffer.from(res.data),
      contentType:
        (res.headers['content-type'] as string | undefined) ?? 'application/octet-stream',
    };
  }

  async registerWebhook(token: string, notificationUrl: string): Promise<{ id: string; resource: string }> {
    const { data } = await axios.post(
      `${AURINKO_BASE}/subscriptions`,
      { resource: '/email/messages', notificationUrl },
      { headers: { ...this.headers(token), 'Content-Type': 'application/json' } },
    );
    return data as { id: string; resource: string };
  }

  async deleteWebhook(token: string, subscriptionId: string): Promise<void> {
    await axios.delete(`${AURINKO_BASE}/subscriptions/${subscriptionId}`, {
      headers: this.headers(token),
    });
  }

  async sendEmail(token: string, dto: SendEmailDto): Promise<{ id: string }> {
    const { data } = await axios.post(
      `${AURINKO_BASE}/email/messages`,
      {
        subject: dto.subject,
        body: dto.body,
        to: dto.to,
        ...(dto.cc?.length ? { cc: dto.cc } : {}),
        ...(dto.attachments?.length
          ? {
              attachments: dto.attachments.map((a) => ({
                name: a.name,
                mimeType: a.mimeType,
                content: a.content,
                inline: a.inline ?? false,
                ...(a.contentId ? { contentId: a.contentId } : {}),
              })),
            }
          : {}),
      },
      {
        headers: { ...this.headers(token), 'Content-Type': 'application/json' },
        params: { bodyType: 'html' },
      },
    );
    return data as { id: string };
  }
}
