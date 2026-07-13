import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import axios from 'axios';

export interface OAuthTokens {
  accessToken: string;
  refreshToken: string;
  expiresAt: Date;
}

export interface GraphMessage {
  id: string;
  internetMessageId: string;
  subject: string;
  bodyPreview: string;
  body: { contentType: string; content: string };
  from: { emailAddress: { name: string; address: string } };
  toRecipients: { emailAddress: { name: string; address: string } }[];
  ccRecipients: { emailAddress: { name: string; address: string } }[];
  hasAttachments: boolean;
  receivedDateTime: string;
  conversationId: string;
  isDraft: boolean;
}

@Injectable()
export class MicrosoftService {
  private readonly logger = new Logger(MicrosoftService.name);
  private readonly clientId: string;
  private readonly clientSecret: string;
  private readonly tenantId: string;
  private readonly redirectUri: string;

  constructor(private readonly config: ConfigService) {
    this.clientId = config.get<string>('MICROSOFT_CLIENT_ID') ?? '';
    this.clientSecret = config.get<string>('MICROSOFT_CLIENT_SECRET') ?? '';
    this.tenantId = config.get<string>('MICROSOFT_TENANT_ID') ?? '';
    this.redirectUri = config.get<string>('MICROSOFT_REDIRECT_URI') ?? '';
  }

  getAuthorizationUrl(state: string): string {
    const params = new URLSearchParams({
      client_id: this.clientId,
      response_type: 'code',
      redirect_uri: this.redirectUri,
      scope: 'offline_access Mail.ReadWrite Mail.Send',
      state,
    });
    return `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/authorize?${params.toString()}`;
  }

  async exchangeCodeForTokens(code: string): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      code,
      redirect_uri: this.redirectUri,
      grant_type: 'authorization_code',
    });

    const { data } = await axios.post(
      `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    return {
      accessToken: data.access_token as string,
      refreshToken: data.refresh_token as string,
      expiresAt: new Date(Date.now() + (data.expires_in as number) * 1000),
    };
  }

  async refreshAccessToken(refreshToken: string): Promise<OAuthTokens> {
    const params = new URLSearchParams({
      client_id: this.clientId,
      client_secret: this.clientSecret,
      refresh_token: refreshToken,
      grant_type: 'refresh_token',
      scope: 'offline_access Mail.ReadWrite Mail.Send',
    });

    const { data } = await axios.post(
      `https://login.microsoftonline.com/${this.tenantId}/oauth2/v2.0/token`,
      params.toString(),
      { headers: { 'Content-Type': 'application/x-www-form-urlencoded' } },
    );

    return {
      accessToken: data.access_token as string,
      refreshToken: (data.refresh_token as string) ?? refreshToken,
      expiresAt: new Date(Date.now() + (data.expires_in as number) * 1000),
    };
  }

  async getMessages(accessToken: string, top = 20, skip = 0): Promise<GraphMessage[]> {
    const { data } = await axios.get('https://graph.microsoft.com/v1.0/me/messages', {
      headers: { Authorization: `Bearer ${accessToken}` },
      params: {
        $top: top,
        $skip: skip,
        $orderby: 'receivedDateTime desc',
        $select:
          'id,internetMessageId,subject,bodyPreview,body,from,toRecipients,ccRecipients,hasAttachments,receivedDateTime,conversationId,isDraft',
      },
    });
    return data.value as GraphMessage[];
  }

  async sendReply(
    accessToken: string,
    messageId: string,
    body: string,
    comment?: string,
  ): Promise<void> {
    await axios.post(
      `https://graph.microsoft.com/v1.0/me/messages/${messageId}/replyAll`,
      { comment: comment ?? body },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );
  }

  async sendNewMessage(
    accessToken: string,
    opts: {
      to: string[];
      subject: string;
      body: string;
      cc?: string[];
    },
  ): Promise<void> {
    const message = {
      subject: opts.subject,
      body: { contentType: 'HTML', content: opts.body },
      toRecipients: opts.to.map((addr) => ({ emailAddress: { address: addr } })),
      ccRecipients: (opts.cc ?? []).map((addr) => ({ emailAddress: { address: addr } })),
    };

    await axios.post(
      'https://graph.microsoft.com/v1.0/me/sendMail',
      { message },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );
  }

  async createSubscription(accessToken: string, notificationUrl: string): Promise<string> {
    const expiry = new Date(Date.now() + 4230 * 60 * 1000); // máximo permitido (~3 días)
    const { data } = await axios.post(
      'https://graph.microsoft.com/v1.0/subscriptions',
      {
        changeType: 'created',
        notificationUrl,
        resource: 'me/mailFolders/Inbox/messages',
        expirationDateTime: expiry.toISOString(),
        clientState: 'mails-bot-webhook',
      },
      { headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' } },
    );
    return data.id as string;
  }
}
