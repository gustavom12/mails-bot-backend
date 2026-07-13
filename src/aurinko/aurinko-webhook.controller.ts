import {
  Controller,
  Post,
  Query,
  Headers,
  RawBodyRequest,
  Req,
  Res,
  HttpCode,
  Logger,
} from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import { InjectModel } from '@nestjs/mongoose';
import { Model } from 'mongoose';
import { Request, Response } from 'express';
import * as crypto from 'crypto';
import { Public } from '../common/decorators/public.decorator';
import { AurinkoSyncService } from './aurinko-sync.service';
import { Mailbox, MailboxDocument } from '../mailboxes/schemas/mailbox.schema';

interface AurinkoWebhookPayload {
  subscription: number;
  resource: string;
  accountId: number;
  lifecycleEvent?: 'error' | 'active';
  error?: string;
  payloads?: Array<{
    id: string;
    changeType: 'created' | 'updated' | 'deleted';
  }>;
}

@Public()
@Controller('aurinko/webhook')
export class AurinkoWebhookController {
  private readonly logger = new Logger(AurinkoWebhookController.name);
  private readonly signingSecret: string;

  constructor(
    private readonly aurinkoSyncService: AurinkoSyncService,
    private readonly config: ConfigService,
    @InjectModel(Mailbox.name) private readonly mailboxModel: Model<MailboxDocument>,
  ) {
    this.signingSecret = config.get<string>('AURINKO_SIGNING_SECRET') ?? '';
  }

  /**
   * Valida la firma HMAC-SHA256 de Aurinko.
   * Formato: v0:{timestamp}:{rawBody}  →  HMAC-SHA256(signingSecret)
   */
  private isValidSignature(
    rawBody: Buffer,
    timestamp: string,
    signature: string,
  ): boolean {
    if (!this.signingSecret) {
      this.logger.warn('AURINKO_SIGNING_SECRET no configurado — omitiendo validación de firma');
      return true;
    }
    const baseString = `v0:${timestamp}:${rawBody.toString('utf8')}`;
    const computed = crypto
      .createHmac('sha256', this.signingSecret)
      .update(baseString, 'utf8')
      .digest('hex');

    // Comparación en tiempo constante para prevenir timing attacks
    try {
      return crypto.timingSafeEqual(
        Buffer.from(computed, 'hex'),
        Buffer.from(signature, 'hex'),
      );
    } catch {
      return false;
    }
  }

  /**
   * Recibe eventos de Aurinko en tiempo real.
   *
   * POST /api/aurinko/webhook
   *
   * Aurinko envía:
   *   Headers: X-Aurinko-Request-Timestamp, X-Aurinko-Signature
   *   Body: { subscription, resource, accountId, payloads: [{ id, changeType }] }
   *
   * Responde 200 inmediatamente y procesa de forma asíncrona.
   */
  @Post()
  async handleWebhook(
    @Req() req: RawBodyRequest<Request>,
    @Res() res: Response,
    @Query('validationToken') validationToken: string,
    @Headers('x-aurinko-request-timestamp') timestamp: string,
    @Headers('x-aurinko-signature') signature: string,
  ) {
    // ── Verificación de URL (handshake al registrar suscripción) ─────────
    if (validationToken) {
      this.logger.log(`URL verification handshake recibido`);
      return res.status(200).type('text/plain').send(validationToken);
    }

    const rawBody = req.rawBody;

    // ── Validar firma ────────────────────────────────────────────────────
    if (rawBody && timestamp && signature) {
      if (!this.isValidSignature(rawBody, timestamp, signature)) {
        this.logger.warn('Firma Aurinko inválida — request descartado');
        return res.status(200).json({ ok: false });
      }
    }

    const body = req.body as AurinkoWebhookPayload;

    // ── Evento de ciclo de vida ──────────────────────────────────────────
    if (body.lifecycleEvent) {
      this.logger.log(`Lifecycle event [${body.lifecycleEvent}] sub=${body.subscription} account=${body.accountId}`);
      if (body.lifecycleEvent === 'error') {
        await this.mailboxModel.updateOne(
          { aurinkoAccountId: body.accountId },
          { $set: { status: 'error' } },
        );
      } else if (body.lifecycleEvent === 'active') {
        await this.mailboxModel.updateOne(
          { aurinkoAccountId: body.accountId, status: 'error' },
          { $set: { status: 'connected' } },
        );
      }
      return res.status(200).json({ ok: true });
    }

    // ── Eventos de mensajes ──────────────────────────────────────────────
    if (!body.payloads?.length) return res.status(200).json({ ok: true });

    this.logger.log(
      `Webhook recibido: account=${body.accountId} resource=${body.resource} payloads=${body.payloads.length}`,
    );

    // Buscar la casilla por aurinkoAccountId (no bloqueante)
    void this.processPayloads(body);

    return res.status(200).json({ ok: true });
  }

  /**
   * Procesa los payloads de forma asíncrona (no bloquea la respuesta 200).
   * Usa syncMailbox completo para evitar problemas con IDs de mensajes enviados.
   */
  private async processPayloads(body: AurinkoWebhookPayload): Promise<void> {
    const hasCreated = body.payloads?.some((p) => p.changeType === 'created');
    if (!hasCreated) return;

    const mailbox = await this.mailboxModel.findOne({
      aurinkoAccountId: body.accountId,
      status: 'connected',
      active: true,
    });

    if (!mailbox) {
      this.logger.warn(`No se encontró casilla para aurinkoAccountId=${body.accountId}`);
      return;
    }

    const tenantId = mailbox.tenantId.toString();
    const mailboxId = (mailbox._id as import('mongoose').Types.ObjectId).toString();

    try {
      const result = await this.aurinkoSyncService.syncMailbox(mailboxId, tenantId);
      if (result.synced > 0) {
        this.logger.log(`Webhook sync ${mailbox.email}: +${result.synced} mensajes nuevos`);
      }
    } catch (err) {
      this.logger.error(`Webhook sync error [${mailbox.email}]:`, err);
    }
  }
}
