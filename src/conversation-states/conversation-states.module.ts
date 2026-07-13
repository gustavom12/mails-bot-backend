import { Module } from '@nestjs/common';
import { MongooseModule } from '@nestjs/mongoose';
import { ConversationState, ConversationStateSchema } from './schemas/conversation-state.schema';
import { ConversationStatesService } from './conversation-states.service';
import { ConversationStatesController } from './conversation-states.controller';

@Module({
  imports: [
    MongooseModule.forFeature([{ name: ConversationState.name, schema: ConversationStateSchema }]),
  ],
  controllers: [ConversationStatesController],
  providers: [ConversationStatesService],
  exports: [MongooseModule, ConversationStatesService],
})
export class ConversationStatesModule {}
