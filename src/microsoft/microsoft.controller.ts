import {
  Controller,
  Get,
  Query,
  Param,
  Redirect,
  BadRequestException,
  Logger,
} from '@nestjs/common';
import { MicrosoftService } from './microsoft.service';
import { MailboxesService } from '../mailboxes/mailboxes.service';
import { EncryptionService } from '../common/crypto/encryption.service';
import { CurrentUser } from '../common/decorators/current-user.decorator';
import { Roles } from '../common/decorators/roles.decorator';
import { Public } from '../common/decorators/public.decorator';
import { UserDocument } from '../users/schemas/user.schema';

@Controller('microsoft')
export class MicrosoftController {
  private readonly logger = new Logger(MicrosoftController.name);

  constructor(
    private readonly microsoftService: MicrosoftService,
    private readonly mailboxesService: MailboxesService,
    private readonly encryptionService: EncryptionService,
  ) {}

  /**
   * Inicia el flujo OAuth — redirige a Microsoft para autorizar la casilla.
   * El `state` codifica tenantId:mailboxId para recuperarlos en el callback.
   */
  @Roles('owner')
  @Get('connect/:mailboxId')
  @Redirect()
  connect(@CurrentUser() me: UserDocument, @Param('mailboxId') mailboxId: string) {
    const state = `${me.tenantId.toString()}:${mailboxId}`;
    const url = this.microsoftService.getAuthorizationUrl(state);
    return { url };
  }

  /**
   * Callback OAuth — Microsoft redirige aquí con el code.
   * Debe ser @Public porque Microsoft no envía la cookie JWT.
   */
  @Public()
  @Get('callback')
  async callback(@Query('code') code: string, @Query('state') state: string) {
    if (!code || !state) throw new BadRequestException('Parámetros OAuth inválidos');

    const [tenantId, mailboxId] = state.split(':');
    if (!tenantId || !mailboxId) throw new BadRequestException('State OAuth inválido');

    try {
      const tokens = await this.microsoftService.exchangeCodeForTokens(code);

      const encryptedAccess = this.encryptionService.encrypt(tokens.accessToken);
      const encryptedRefresh = this.encryptionService.encrypt(tokens.refreshToken);

      await this.mailboxesService.saveTokens(mailboxId, tenantId, {
        accessToken: encryptedAccess,
        refreshToken: encryptedRefresh,
        tokenExpiresAt: tokens.expiresAt,
        status: 'connected',
      });

      return { message: 'Casilla conectada exitosamente', mailboxId };
    } catch (err) {
      this.logger.error('OAuth callback failed', err);
      await this.mailboxesService.setStatus(mailboxId, tenantId, 'error');
      throw new BadRequestException('Error al conectar la casilla con Microsoft');
    }
  }
}
