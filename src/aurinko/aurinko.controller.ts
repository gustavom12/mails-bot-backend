import {
  Controller,
  Get,
  Post,
  Body,
  Query,
  Param,
  Headers,
  Redirect,
  BadRequestException,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { AurinkoService, SendEmailDto } from './aurinko.service';
import { AurinkoSyncService } from './aurinko-sync.service';
import { MailboxesService } from '../mailboxes/mailboxes.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UserDocument } from '../users/schemas/user.schema';

@Controller('aurinko')
export class AurinkoController {
  private readonly logger = new Logger(AurinkoController.name);

  constructor(
    private readonly aurinkoService: AurinkoService,
    private readonly aurinkoSyncService: AurinkoSyncService,
    private readonly mailboxesService: MailboxesService,
    private readonly encryptionService: EncryptionService,
    private readonly config: ConfigService,
  ) {}

  // ─── Flujo OAuth ──────────────────────────────────────────────────────

  /**
   * Inicia el flujo OAuth con Aurinko.
   * Detecta el serviceType a partir del email guardado en la casilla.
   *
   * GET /aurinko/connect/:mailboxId
   */
  @Roles('owner')
  @Get('connect/:mailboxId')
  @Redirect()
  async connect(
    @CurrentUser() me: UserDocument,
    @Param('mailboxId') mailboxId: string,
  ) {
    const mailbox = await this.mailboxesService.findOne(me.tenantId.toString(), mailboxId);
    const serviceType = this.aurinkoService.detectServiceType(mailbox.email);
    const state = `${me.tenantId.toString()}:${mailboxId}`;
    const url = this.aurinkoService.getAuthorizationUrl(state, serviceType);
    this.logger.log(`OAuth connect → mailbox=${mailboxId} serviceType=${serviceType}`);
    return { url };
  }

  /**
   * Callback de Aurinko tras autorización.
   * Intercambia el code por el accessToken y lo guarda cifrado en la casilla.
   *
   * GET /aurinko/callback?code=...&state=tenantId:mailboxId
   */
  @Public()
  @Get('callback')
  async callback(
    @Query('code') code: string,
    @Query('state') state: string,
  ) {
    if (!code || !state) throw new BadRequestException('Parámetros OAuth inválidos');

    const [tenantId, mailboxId] = state.split(':');
    if (!tenantId || !mailboxId) throw new BadRequestException('State OAuth inválido');

    const frontendUrl = this.config.get<string>('FRONTEND_URL') ?? 'http://localhost:3000';

    try {
      const { accountId, accessToken } = await this.aurinkoService.exchangeCodeForToken(code);
      const encryptedAccess = this.encryptionService.encrypt(accessToken);

      await this.mailboxesService.saveTokens(mailboxId, tenantId, {
        accessToken: encryptedAccess,
        refreshToken: null,
        tokenExpiresAt: null,
        aurinkoAccountId: accountId,
        status: 'connected',
      });

      this.logger.log(`OAuth callback OK → mailboxId=${mailboxId}`);
      return { url: `${frontendUrl}/mailboxes?connected=1` };
    } catch (err) {
      this.logger.error('OAuth callback failed', err);
      await this.mailboxesService.setStatus(mailboxId, tenantId, 'error');
      return { url: `${frontendUrl}/mailboxes?error=1` };
    }
  }

  // ─── Suscripción webhook ──────────────────────────────────────────────

  /**
   * Registra un webhook de Aurinko para la casilla.
   * Requiere una URL pública (ngrok en dev, dominio en prod).
   *
   * POST /aurinko/subscribe/:mailboxId
   * Body: { notificationUrl: "https://tu-dominio.com" }
   */
  @Roles('owner')
  @Post('subscribe/:mailboxId')
  @HttpCode(200)
  async subscribe(
    @CurrentUser() me: UserDocument,
    @Param('mailboxId') mailboxId: string,
    @Body('notificationUrl') notificationUrl: string,
  ) {
    if (!notificationUrl) {
      throw new BadRequestException('notificationUrl es requerido');
    }

    const mailbox = await this.mailboxesService.findOne(me.tenantId.toString(), mailboxId);
    if (mailbox.status !== 'connected' || !mailbox.accessToken) {
      throw new BadRequestException('La casilla no está conectada');
    }

    const token = this.encryptionService.decrypt(mailbox.accessToken);
    const webhookUrl = `${notificationUrl}/api/aurinko/webhook`;
    const sub = await this.aurinkoService.registerWebhook(token, webhookUrl);

    this.logger.log(`Webhook registrado: sub=${sub.id} mailbox=${mailbox.email} url=${webhookUrl}`);
    return { subscriptionId: sub.id, webhookUrl, resource: sub.resource };
  }

  // ─── Sincronización ───────────────────────────────────────────────────

  /**
   * Sincroniza los emails de una casilla conectada → popula Conversations + Messages.
   *
   * POST /aurinko/sync/:mailboxId
   */
  @Roles('owner')
  @Post('sync/:mailboxId')
  @HttpCode(200)
  async sync(
    @CurrentUser() me: UserDocument,
    @Param('mailboxId') mailboxId: string,
  ) {
    this.logger.log(`Manual sync → mailboxId=${mailboxId}`);
    return this.aurinkoSyncService.syncMailbox(mailboxId, me.tenantId.toString());
  }

  // ─── Endpoints de prueba ──────────────────────────────────────────────

  private resolveToken(authHeader?: string, queryToken?: string): string {
    const token =
      queryToken ??
      (authHeader?.startsWith('Bearer ') ? authHeader.slice(7) : authHeader);
    if (!token) {
      throw new BadRequestException(
        'Se requiere el access token. Enviarlo en Authorization: Bearer <token> o ?token=<token>',
      );
    }
    return token;
  }

  /** GET /aurinko/account */
  @Public()
  @Get('account')
  async getAccount(
    @Headers('authorization') auth: string,
    @Query('token') queryToken: string,
  ) {
    return this.aurinkoService.getAccount(this.resolveToken(auth, queryToken));
  }

  /** GET /aurinko/messages?limit=20&pageToken=... */
  @Public()
  @Get('messages')
  async getMessages(
    @Headers('authorization') auth: string,
    @Query('token') queryToken: string,
    @Query('limit') limit?: string,
    @Query('pageToken') pageToken?: string,
  ) {
    return this.aurinkoService.getMessages(
      this.resolveToken(auth, queryToken),
      pageToken,
      limit ? Number(limit) : 20,
    );
  }

  /** POST /aurinko/send */
  @Public()
  @Post('send')
  async sendEmail(
    @Headers('authorization') auth: string,
    @Query('token') queryToken: string,
    @Body() dto: SendEmailDto,
  ) {
    if (!dto.subject || !dto.body || !dto.to?.length) {
      throw new BadRequestException('subject, body y to son obligatorios');
    }
    return this.aurinkoService.sendEmail(this.resolveToken(auth, queryToken), dto);
  }
}
