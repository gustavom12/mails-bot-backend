import { Controller, Post, Get, Query, Body, HttpCode, Logger } from '@nestjs/common';
import { Public } from '../common/decorators/public.decorator';
import { MailSyncService } from '../mail/mail-sync.service';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Mailbox, MailboxDocument } from '../mailboxes/schemas/mailbox.schema';

interface GraphNotification {
  value: Array<{
    clientState: string;
    resource: string;
    resourceData?: { id?: string };
    subscriptionId: string;
  }>;
}

@Controller('microsoft/webhook')
export class WebhookController {
  private readonly logger = new Logger(WebhookController.name);

  constructor(
    private readonly mailSyncService: MailSyncService,
    @InjectModel(Mailbox.name) private readonly mailboxModel: Model<MailboxDocument>,
  ) {}

  /**
   * Microsoft envía una solicitud de validación con validationToken.
   * Debe responder con el token en texto plano.
   */
  @Public()
  @Get()
  validate(@Query('validationToken') validationToken: string) {
    return validationToken;
  }

  /**
   * Microsoft envía notificaciones de nuevos emails aquí.
   */
  @Public()
  @Post()
  @HttpCode(202)
  async notify(@Body() body: GraphNotification) {
    if (!body?.value?.length) return;

    for (const notification of body.value) {
      if (notification.clientState !== 'mails-bot-webhook') continue;

      // Buscamos la casilla conectada y sincronizamos
      const connectedMailboxes = await this.mailboxModel
        .find({ status: 'connected', active: true })
        .exec();

      for (const mailbox of connectedMailboxes) {
        try {
          const result = await this.mailSyncService.syncMailbox(mailbox._id.toString());
          if (result.synced > 0) {
            this.logger.log(`Webhook sync ${mailbox.email}: +${result.synced} mensajes`);
          }
        } catch (err) {
          this.logger.error(`Webhook sync error ${mailbox.email}:`, err);
        }
      }
    }
  }
}
