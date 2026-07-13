import { Controller, Post, Param, Body, HttpCode } from '@nestjs/common';
import { MailSyncService } from './mail-sync.service';
import { MicrosoftService } from '../microsoft/microsoft.service';
import { MailboxesService } from '../mailboxes/mailboxes.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { UserDocument } from '../users/schemas/user.schema';
import { BadRequestException } from '@nestjs/common';

@Controller('mail')
export class MailController {
  constructor(
    private readonly mailSyncService: MailSyncService,
    private readonly microsoftService: MicrosoftService,
    private readonly mailboxesService: MailboxesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /** Sincronización manual — trae los últimos emails de la casilla. */
  @Roles('owner')
  @Post('sync/:mailboxId')
  @HttpCode(200)
  sync(@CurrentUser() me: UserDocument, @Param('mailboxId') mailboxId: string) {
    return this.mailSyncService.syncMailbox(mailboxId, me.tenantId.toString());
  }

  /**
   * Registra un webhook de Microsoft Graph para recibir emails en tiempo real.
   * Requiere que el backend tenga una URL pública (ngrok en dev, dominio en prod).
   * Body: { notificationUrl: "https://tu-url-publica.com" }
   */
  @Roles('owner')
  @Post('subscribe/:mailboxId')
  @HttpCode(200)
  async subscribe(
    @CurrentUser() me: UserDocument,
    @Param('mailboxId') mailboxId: string,
    @Body('notificationUrl') notificationUrl: string,
  ) {
    if (!notificationUrl) throw new BadRequestException('notificationUrl es requerido');

    const mailboxes = await this.mailboxesService.findAll(me.tenantId.toString());
    const mailbox = mailboxes.find((m) => m._id.toString() === mailboxId);
    if (!mailbox || mailbox.status !== 'connected') {
      throw new BadRequestException('Casilla no encontrada o no conectada');
    }

    const accessToken = await this.mailSyncService.getValidAccessToken(mailbox);
    const webhookUrl = `${notificationUrl}/api/microsoft/webhook`;
    const subscriptionId = await this.microsoftService.createSubscription(accessToken, webhookUrl);

    return { subscriptionId, webhookUrl, message: 'Webhook registrado. Vence en ~3 días.' };
  }
}
