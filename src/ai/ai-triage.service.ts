import { Injectable, Logger } from '@nestjs/common';
import { InjectModel } from '@nestjs/mongoose';
import { Model, Types } from 'mongoose';
import { Conversation, ConversationDocument } from '../conversations/schemas/conversation.schema';
import { Message, MessageDocument } from '../messages/schemas/message.schema';
import { Hotel, HotelDocument } from '../hotels/schemas/hotel.schema';
import { ConversationState, ConversationStateDocument } from '../conversation-states/schemas/conversation-state.schema';
import { TemplatesService } from '../templates/templates.service';
import { OpenAiService } from './openai.service';

interface TriageResult {
  stateName: string;
  reply: string;
  source: 'template' | 'generated';
  templateId?: string;
  summary?: string;
}

@Injectable()
export class AiTriageService {
  private readonly logger = new Logger(AiTriageService.name);

  constructor(
    @InjectModel(Conversation.name) private readonly conversationModel: Model<ConversationDocument>,
    @InjectModel(Message.name) private readonly messageModel: Model<MessageDocument>,
    @InjectModel(Hotel.name) private readonly hotelModel: Model<HotelDocument>,
    @InjectModel(ConversationState.name) private readonly stateModel: Model<ConversationStateDocument>,
    private readonly templatesService: TemplatesService,
    private readonly openAiService: OpenAiService,
  ) {}

  /**
   * Procesa un mail entrante: clasifica la conversación (kanban) y genera una
   * respuesta sugerida (desde template o generada). Nunca envía el mail.
   * Se llama de forma asíncrona desde el webhook, nunca bloquea el sync.
   */
  async processInbound(
    conversationId: string,
    tenantId: string,
    messageId: string,
  ): Promise<void> {
    if (!this.openAiService.isEnabled) return;

    try {
      await this._doProcessInbound(conversationId, tenantId, messageId);
    } catch (err) {
      this.logger.error(`Error en triage IA [conv=${conversationId}]:`, err);
    }
  }

  private async _doProcessInbound(
    conversationId: string,
    tenantId: string,
    messageId: string,
  ): Promise<void> {
    // --- 1. Cargar datos del mensaje y conversación ---
    const [conversation, message] = await Promise.all([
      this.conversationModel.findOne({
        _id: new Types.ObjectId(conversationId),
        tenantId: new Types.ObjectId(tenantId),
      }),
      this.messageModel.findById(messageId),
    ]);

    if (!conversation || !message) {
      this.logger.warn(`Triage IA: conversación o mensaje no encontrado [conv=${conversationId}]`);
      return;
    }

    const emailText = `${message.subject ?? ''}\n\n${message.bodyPreview ?? ''}`.trim();

    // --- 2. Cargar contexto del hotel ---
    const hotel = await this.hotelModel.findById(conversation.hotelId);
    if (!hotel) {
      this.logger.warn(`Triage IA: hotel no encontrado [hotelId=${conversation.hotelId}]`);
      return;
    }

    // --- 3. Buscar templates por keywords ---
    const templates = await this.templatesService.searchByText(
      tenantId,
      conversation.hotelId.toString(),
      emailText,
      5,
    );

    // --- 4. Buscar conversaciones previas similares ---
    const prevConversations = await this._findSimilarPrevious(
      tenantId,
      conversation.hotelId.toString(),
      conversationId,
      emailText,
    );

    // --- 5. Cargar estados del kanban ---
    const states = await this.stateModel
      .find({ tenantId: new Types.ObjectId(tenantId), active: true })
      .sort({ order: 1 })
      .exec();

    // --- 6. Llamar a OpenAI ---
    const systemPrompt = this._buildSystemPrompt(hotel, states);
    const userPrompt = this._buildUserPrompt(emailText, templates, prevConversations);

    const result = await this.openAiService.chatJson<TriageResult>(systemPrompt, userPrompt);

    if (!result?.stateName || !result?.reply) {
      this.logger.warn(`Triage IA: respuesta inválida de OpenAI [conv=${conversationId}]`);
      return;
    }

    // --- 7. Mapear stateName -> stateId ---
    let targetState = states.find(
      (s) => s.name.toLowerCase() === result.stateName.toLowerCase(),
    ) ?? states.find((s) => s.isDefault) ?? states[0];

    if (!targetState) {
      this.logger.warn(`Triage IA: no se pudo mapear estado "${result.stateName}"`);
      return;
    }

    // Fallback determinístico: si ya preparamos una respuesta, la conversación
    // no debe quedar en el estado por defecto ("Nuevo" = sin procesar).
    // La movemos al estado de "respuesta preparada" (o el primer estado
    // accionable no-default y no-cerrado disponible).
    if (result.reply.trim() && targetState.isDefault) {
      const preparedState =
        states.find((s) => !s.isDefault && !s.isClosed && /prepar/i.test(s.name)) ??
        states.find((s) => !s.isDefault && !s.isClosed);
      if (preparedState) targetState = preparedState;
    }

    // --- 8. Resolver templateId si aplica ---
    let resolvedTemplateId: Types.ObjectId | null = null;
    if (result.source === 'template' && result.templateId) {
      const matchedTemplate = templates.find((t) => (t._id as Types.ObjectId).toString() === result.templateId);
      if (matchedTemplate) resolvedTemplateId = matchedTemplate._id as Types.ObjectId;
    }

    // --- 9. Guardar sugerencia y mover conversación ---
    await this.conversationModel.updateOne(
      { _id: conversation._id },
      {
        $set: {
          stateId: targetState._id,
          aiSuggestedReply: result.reply,
          aiReplySource: result.source,
          aiSuggestedTemplateId: resolvedTemplateId,
          aiProcessedAt: new Date(),
          aiSummary: result.summary ?? null,
        },
      },
    );

    this.logger.log(
      `Triage IA completado [conv=${conversationId}] estado="${targetState.name}" source="${result.source}"`,
    );
  }

  private async _findSimilarPrevious(
    tenantId: string,
    hotelId: string,
    excludeConversationId: string,
    searchText: string,
  ): Promise<{ subject: string; preview: string }[]> {
    if (!searchText?.trim()) return [];

    try {
      const messages = await this.messageModel
        .find(
          {
            $text: { $search: searchText },
            tenantId: new Types.ObjectId(tenantId),
            direction: 'inbound',
            conversationId: { $ne: new Types.ObjectId(excludeConversationId) },
          },
          { score: { $meta: 'textScore' } },
        )
        .sort({ score: { $meta: 'textScore' } })
        .limit(3)
        .lean()
        .exec();

      return messages.map((m) => ({
        subject: m.subject ?? '',
        preview: m.bodyPreview?.slice(0, 300) ?? '',
      }));
    } catch {
      return [];
    }
  }

  private _buildSystemPrompt(hotel: HotelDocument, states: ConversationStateDocument[]): string {
    const defaultStateName = states.find((s) => s.isDefault)?.name ?? states[0]?.name ?? '';

    const statesList = states
      .map((s, i) => {
        const tags: string[] = [];
        if (s.isDefault) tags.push('columna inicial / sin procesar — NO la elijas');
        if (s.isClosed) tags.push('conversación cerrada / resuelta');
        return `${i + 1}. "${s.name}"${tags.length ? ` (${tags.join(', ')})` : ''}`;
      })
      .join('\n');

    return `Eres un asistente de gestión de emails para el hotel "${hotel.name}".

INFORMACIÓN DEL HOTEL:
- Tono de comunicación: ${hotel.tone || 'Profesional y amable'}
- Información de marca: ${hotel.brandInfo || 'Hotel de servicio premium'}
- Firma: ${hotel.signature || ''}
- Reglas especiales: ${hotel.aiRules?.length ? hotel.aiRules.join('; ') : 'Ninguna'}

COLUMNAS DISPONIBLES EN EL KANBAN (debes elegir exactamente una, usando su nombre EXACTO):
${statesList}

INSTRUCCIONES:
1. Analiza el email entrante y clasifícalo en la columna del kanban más apropiada.
2. IMPORTANTE: Como estás procesando el email y preparando una respuesta, NUNCA lo dejes en la columna inicial "${defaultStateName}" (esa columna es solo para mensajes sin procesar). Elegí la columna que refleje que ya hay una respuesta lista para revisar/enviar (por ejemplo, una columna del tipo "Respuesta preparada"), salvo que el caso requiera atención especial.
3. Para la respuesta: si alguno de los TEMPLATES DISPONIBLES aplica al email (aunque sea parcialmente), DEBES usarlo. Devuelve source="template" y su templateId exacto, adaptando el contenido al email si hace falta. Solo usá source="generated" si NINGÚN template aplica; en ese caso, basate en las conversaciones previas similares y en el tono del hotel.
4. La respuesta debe estar en el mismo idioma que el email entrante.
5. Incluye la firma del hotel si se proporcionó.
6. Sé conciso y profesional.

Responde ÚNICAMENTE con un objeto JSON con esta estructura exacta:
{
  "stateName": "nombre exacto de la columna del kanban",
  "reply": "texto de la respuesta sugerida",
  "source": "template" | "generated",
  "templateId": "id del template usado (solo si source=template, sino omitir)",
  "summary": "resumen de 1 línea explicando la clasificación"
}`;
  }

  private _buildUserPrompt(
    emailText: string,
    templates: { _id: unknown; name: string; description: string; body: string }[],
    prevConversations: { subject: string; preview: string }[],
  ): string {
    const parts: string[] = [];

    parts.push(`EMAIL ENTRANTE:\n${emailText}`);

    if (templates.length > 0) {
      parts.push(
        `\nTEMPLATES DISPONIBLES (relevantes por keywords):\n` +
          templates
            .map(
              (t, i) =>
                `[${i + 1}] ID: ${(t._id as Types.ObjectId).toString()}\nNombre: ${t.name}\nContexto: ${t.description}\nRespuesta: ${t.body}`,
            )
            .join('\n\n'),
      );
    } else {
      parts.push('\nNo hay templates disponibles para este hotel.');
    }

    if (prevConversations.length > 0) {
      parts.push(
        `\nCONVERSACIONES PREVIAS SIMILARES (para referencia de tono y contexto):\n` +
          prevConversations
            .map((c, i) => `[${i + 1}] Asunto: ${c.subject}\n${c.preview}`)
            .join('\n\n'),
      );
    }

    return parts.join('\n');
  }
}
