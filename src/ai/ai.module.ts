import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { Conversation, ConversationSchema } from '../conversations/schemas/conversation.schema';
import { Message, MessageSchema } from '../messages/schemas/message.schema';
import { Hotel, HotelSchema } from '../hotels/schemas/hotel.schema';
import { ConversationState, ConversationStateSchema } from '../conversation-states/schemas/conversation-state.schema';
import { TemplatesModule } from '../templates/templates.module';
import { OpenAiService } from './openai.service';
import { AiTriageService } from './ai-triage.service';

@Module({
  imports: [
    MongooseModule.forFeature([
      { name: Conversation.name, schema: ConversationSchema },
      { name: Message.name, schema: MessageSchema },
      { name: Hotel.name, schema: HotelSchema },
      { name: ConversationState.name, schema: ConversationStateSchema },
    ]),
    TemplatesModule,
  ],
  providers: [OpenAiService, AiTriageService],
  exports: [AiTriageService],
})
export class AiModule {}
