import { Module } from '@nestjs/common';
import { MicrosoftService } from './microsoft.service';
import { MicrosoftController } from './microsoft.controller';
import { MailboxesModule } from '../mailboxes/mailboxes.module';

@Module({
  imports: [MailboxesModule],
  controllers: [MicrosoftController],
  providers: [MicrosoftService],
  exports: [MicrosoftService],
})
export class MicrosoftModule {}
