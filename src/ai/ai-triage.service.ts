import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
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

export interface InternalCheckResult {
  internal: boolean;
  confidence: number;
  category?: string;
  reason?: string;
}

/**
 * Prompts del clasificador de mails internos. Exportados para que el script
 * de diagnóstico (src/scripts/check-internals.ts) use exactamente los mismos.
 */
export function buildInternalCheckSystemPrompt(): string {
  return `Sos un clasificador de emails entrantes para la casilla de correo de un hotel. Tu ÚNICA tarea es decidir si el email es un correo interno/automático que NO requiere ninguna respuesta ni acción de una persona.

SON INTERNOS (internal=true) SOLO los correos 100% automáticos sin acción pendiente:
- Notificaciones transaccionales de sistemas (confirmaciones de entrega de emails, digests automáticos, reportes programados)
- Newsletters y correos promocionales / de marketing
- Spam
- Alertas automáticas de plataformas y correos de remitentes no-reply que son puramente informativos

NO SON INTERNOS (internal=false) — cualquier correo donde una persona podría esperar lectura, respuesta o acción:
- Consultas, reservas, quejas o mensajes de huéspedes/clientes (aunque los haya generado un formulario)
- Notificaciones de reservas de OTAs (Booking, Expedia, etc.) que pueden requerir acción del hotel
- Facturas o cobros que deben pagarse o revisarse
- Cualquier correo escrito por una persona

REGLAS ESTRICTAS:
1. Ante la MÁS MÍNIMA duda, internal=false. Solo internal=true si estás totalmente seguro de que nadie necesita leerlo ni responderlo.
2. "confidence" (0 a 1) es tu certeza de que NO requiere ninguna atención humana.

Respondé ÚNICAMENTE con un objeto JSON:
{"internal": true|false, "confidence": 0.0, "category": "transactional"|"promotional"|"spam"|"system"|"other", "reason": "explicación de 1 línea"}`;
}

export function buildInternalCheckUserPrompt(email: {
  fromName?: string | null;
  fromAddress?: string | null;
  subject?: string | null;
  bodyPreview?: string | null;
}): string {
  return `EMAIL ENTRANTE:
Remitente: ${email.fromName ?? ''} <${email.fromAddress ?? ''}>
Asunto: ${email.subject ?? '(sin asunto)'}
Contenido (preview):
${(email.bodyPreview ?? '').slice(0, 800)}`;
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
    private readonly config: ConfigService,
  ) {}

  /**
   * Punto de entrada para mails entrantes desde el sync/webhook.
   * Primero evalúa si el mail es 100% interno (transaccional, promocional,
   * spam, etc.) y en ese caso lo manda a la columna "Internos" leído y sin
   * pedir atención. Ante la mínima duda, sigue el flujo normal de triage.
   */
  async triageInbound(
    conversationId: string,
    tenantId: string,
    messageId: string,
    opts: { newConversation?: boolean } = {},
  ): Promise<void> {
    try {
      const routedToInternal = await this._routeInternalIfCertain(
        conversationId,
        tenantId,
        messageId,
        opts.newConversation ?? false,
      );
      if (routedToInternal) return;
    } catch (err) {
      this.logger.error(`Error en clasificación de internos [conv=${conversationId}]:`, err);
    }

    await this.processInbound(conversationId, tenantId, messageId);
  }

  /**
   * Clasifica el mail como interno SOLO si la IA está totalmente segura de que
   * no requiere respuesta ni acción humana. Devuelve true si lo enrutó.
   *
   * - Requiere que exista un estado activo con nombre INTERNAL_STATE_NAME
   *   (default "Internos") en el tenant; si no existe, no hace nada.
   * - Solo clasifica conversaciones nuevas: un hilo con historial humano nunca
   *   se archiva solo. Los mensajes siguientes de un hilo ya interno se
   *   mantienen leídos y en la misma columna, sin volver a llamar a la IA.
   */
  private async _routeInternalIfCertain(
    conversationId: string,
    tenantId: string,
    messageId: string,
    isNewConversation: boolean,
  ): Promise<boolean> {
    const internalStateName = this.config.get<string>('INTERNAL_STATE_NAME') ?? 'Internos';
    const internalState = await this.stateModel.findOne({
      tenantId: new Types.ObjectId(tenantId),
      name: internalStateName,
      active: true,
    });
    if (!internalState) return false;

    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });
    if (!conversation) return false;

    if (conversation.stateId?.toString() === (internalState._id as Types.ObjectId).toString()) {
      await this.conversationModel.updateOne(
        { _id: conversation._id },
        { $set: { unread: false } },
      );
      return true;
    }

    if (!isNewConversation) return false;
    if (!this.openAiService.isEnabled) return false;

    const message = await this.messageModel.findById(messageId);
    if (!message) return false;

    const result = await this.openAiService.chatJson<InternalCheckResult>(
      buildInternalCheckSystemPrompt(),
      buildInternalCheckUserPrompt({
        fromName: message.from?.name,
        fromAddress: message.from?.address,
        subject: message.subject,
        bodyPreview: message.bodyPreview,
      }),
    );

    const minConfidence = Number(this.config.get<string>('INTERNAL_MIN_CONFIDENCE') ?? '0.95');
    if (
      !result ||
      result.internal !== true ||
      typeof result.confidence !== 'number' ||
      result.confidence < minConfidence
    ) {
      return false;
    }

    const category = result.category ?? 'automático';
    await this.conversationModel.updateOne(
      { _id: conversation._id },
      {
        $set: {
          stateId: internalState._id,
          unread: false,
          aiProcessedAt: new Date(),
          aiSummary: `Interno (${category}): ${result.reason ?? 'sin detalle'}`,
        },
        $push: {
          statusHistory: {
            stateId: internalState._id,
            stateName: internalState.name,
            changedBy: null,
            changedAt: new Date(),
            note: `auto: clasificado como interno por IA (${category}, confianza ${Math.round(result.confidence * 100)}%)`,
          },
        },
      },
    );

    this.logger.log(
      `Mail interno → "${internalState.name}" [conv=${conversationId}] categoría=${category} confianza=${result.confidence}`,
    );
    return true;
  }


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

    // Sin hotel asignado no hay contexto para la IA: se procesará al asignarlo manualmente.
    if (!conversation.hotelId) {
      this.logger.debug(`Triage IA: conversación sin hotel asignado [conv=${conversationId}], se omite`);
      return;
    }

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

  /**
   * Prepara un draft de seguimiento cuando el cliente no respondió.
   * Busca templates con tags de seguimiento, adapta el body y lo guarda en
   * aiSuggestedReply. Nunca envía el mail ni cambia el estado del kanban.
   */
  async prepareFollowupDraft(conversationId: string, tenantId: string): Promise<void> {
    try {
      await this._doPrepareFollowupDraft(conversationId, tenantId);
    } catch (err) {
      this.logger.error(`Error en draft de seguimiento [conv=${conversationId}]:`, err);
    }
  }

  private async _doPrepareFollowupDraft(
    conversationId: string,
    tenantId: string,
  ): Promise<void> {
    const conversation = await this.conversationModel.findOne({
      _id: new Types.ObjectId(conversationId),
      tenantId: new Types.ObjectId(tenantId),
    });

    if (!conversation) {
      this.logger.warn(`Followup draft: conversación no encontrada [conv=${conversationId}]`);
      return;
    }

    if (!conversation.hotelId) {
      this.logger.debug(
        `Followup draft: conversación sin hotel [conv=${conversationId}], se omite`,
      );
      return;
    }

    const hotelId = conversation.hotelId.toString();
    const followupTags = ['seguimiento', 'follow-up', 'followup', 'follow_up'];

    let templates = await this.templatesService.findByTags(
      tenantId,
      hotelId,
      followupTags,
      5,
    );

    // Fallback: búsqueda por texto si no hay tags explícitos
    if (templates.length === 0) {
      templates = await this.templatesService.searchByText(
        tenantId,
        hotelId,
        'seguimiento follow-up followup',
        5,
      );
      // searchByText hace fallback a todos los templates del hotel; filtramos
      // a los que parezcan de seguimiento por nombre/descripcion/tags.
      templates = templates.filter((t) => {
        const haystack = `${t.name} ${t.description} ${(t.tags ?? []).join(' ')}`.toLowerCase();
        return /seguimiento|follow[\s_-]?up|followup/.test(haystack);
      });
    }

    if (templates.length === 0) {
      this.logger.debug(
        `Followup draft: sin templates de seguimiento [conv=${conversationId} hotel=${hotelId}]`,
      );
      return;
    }

    const hotel = await this.hotelModel.findById(conversation.hotelId);
    if (!hotel) {
      this.logger.warn(`Followup draft: hotel no encontrado [hotelId=${hotelId}]`);
      return;
    }

    const lastOutbound = await this.messageModel
      .findOne({ conversationId: conversation._id, direction: 'outbound' })
      .sort({ receivedAt: -1 })
      .select('subject bodyPreview')
      .lean()
      .exec();

    const contactName = conversation.contactName?.trim() || '';
    let reply = this._applySimpleFollowupVars(templates[0].body, contactName);
    let templateId = templates[0]._id as Types.ObjectId;
    let source: 'template' | 'generated' = 'template';
    let summary = `Seguimiento automático: template "${templates[0].name}"`;

    if (this.openAiService.isEnabled) {
      const adapted = await this.openAiService.chatJson<{
        reply?: string;
        templateId?: string;
        summary?: string;
      }>(
        this._buildFollowupSystemPrompt(hotel),
        this._buildFollowupUserPrompt(
          {
            subject: conversation.subject,
            contactName,
            contactEmail: conversation.contactEmail,
            lastOutboundPreview: lastOutbound?.bodyPreview ?? '',
          },
          templates,
        ),
      );

      if (adapted?.reply?.trim()) {
        reply = adapted.reply.trim();
        const matched = templates.find(
          (t) => (t._id as Types.ObjectId).toString() === adapted.templateId,
        );
        if (matched) {
          templateId = matched._id as Types.ObjectId;
          summary = adapted.summary?.trim() || `Seguimiento automático: template "${matched.name}"`;
        } else {
          // La IA adaptó pero no devolvió un templateId válido: usamos el primero
          summary = adapted.summary?.trim() || summary;
        }
        source = 'template';
      }
    }

    await this.conversationModel.updateOne(
      { _id: conversation._id },
      {
        $set: {
          aiSuggestedReply: reply,
          aiReplySource: source,
          aiSuggestedTemplateId: templateId,
          aiProcessedAt: new Date(),
          aiSummary: summary,
        },
      },
    );

    this.logger.log(
      `Followup draft listo [conv=${conversationId}] template=${templateId.toString()}`,
    );
  }

  private _applySimpleFollowupVars(body: string, contactName: string): string {
    if (!contactName) return body;
    return body
      .replace(/\[NOMBRE\]/gi, contactName)
      .replace(/\[NAME\]/gi, contactName);
  }

  private _buildFollowupSystemPrompt(hotel: HotelDocument): string {
    return `Eres un asistente de gestión de emails para el hotel "${hotel.name}".

INFORMACIÓN DEL HOTEL:
- Tono de comunicación: ${hotel.tone || 'Profesional y amable'}
- Información de marca: ${hotel.brandInfo || 'Hotel de servicio premium'}
- Reglas especiales: ${hotel.aiRules?.length ? hotel.aiRules.join('; ') : 'Ninguna'}

CONTEXTO:
El cliente no respondió tras un mensaje saliente del hotel. Debés preparar un mail de seguimiento amable usando UNO de los templates de seguimiento disponibles.

INSTRUCCIONES:
1. DEBES usar uno de los TEMPLATES DE SEGUIMIENTO indicados. Devuelve su templateId exacto.
2. Adaptá variables como [NOMBRE] con el nombre del contacto si está disponible. No inventes disponibilidad, precios, habitaciones ni datos operativos.
3. NO incluyas firma ni despedida firmada: la firma del hotel se agrega automáticamente.
4. El campo "reply" DEBE ser HTML simple válido (<p>, <br>, <strong>, <em>, <ul>, <ol>, <li>). Preservá el formato HTML del template. No uses markdown.
5. Sé conciso y profesional. No inventes que el cliente escribió algo nuevo.

Responde ÚNICAMENTE con un objeto JSON:
{
  "reply": "<p>respuesta sugerida en HTML</p>",
  "templateId": "id del template usado",
  "summary": "resumen de 1 línea"
}`;
  }

  private _buildFollowupUserPrompt(
    ctx: {
      subject: string;
      contactName: string;
      contactEmail: string;
      lastOutboundPreview: string;
    },
    templates: { _id: unknown; name: string; description: string; body: string }[],
  ): string {
    const templatesBlock = templates
      .map(
        (t, i) =>
          `[${i + 1}] ID: ${(t._id as Types.ObjectId).toString()}\nNombre: ${t.name}\nContexto: ${t.description}\nRespuesta (HTML): ${t.body}`,
      )
      .join('\n\n');

    return `CONVERSACIÓN SIN RESPUESTA DEL CLIENTE:
Asunto: ${ctx.subject}
Contacto: ${ctx.contactName || '(sin nombre)'} <${ctx.contactEmail}>
Último mensaje enviado por el hotel (preview):
${ctx.lastOutboundPreview || '(no disponible)'}

TEMPLATES DE SEGUIMIENTO:
${templatesBlock}`;
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
- Reglas especiales: ${hotel.aiRules?.length ? hotel.aiRules.join('; ') : 'Ninguna'}

COLUMNAS DISPONIBLES EN EL KANBAN (debes elegir exactamente una, usando su nombre EXACTO):
${statesList}

INSTRUCCIONES:
1. Analiza el email entrante y clasifícalo en la columna del kanban más apropiada.
2. IMPORTANTE: Como estás procesando el email y preparando una respuesta, NUNCA lo dejes en la columna inicial "${defaultStateName}" (esa columna es solo para mensajes sin procesar). Elegí la columna que refleje que ya hay una respuesta lista para revisar/enviar (por ejemplo, una columna del tipo "Respuesta preparada"), salvo que el caso requiera atención especial.
3. Para la respuesta: si alguno de los TEMPLATES DISPONIBLES aplica al email (aunque sea parcialmente), DEBES usarlo. Devuelve source="template" y su templateId exacto, adaptando el contenido al email si hace falta. Solo usá source="generated" si NINGÚN template aplica; en ese caso, basate en las conversaciones previas similares y en el tono del hotel.
4. La respuesta debe estar en el mismo idioma que el email entrante.
5. NO incluyas ninguna firma ni despedida firmada al final: la firma del hotel se agrega automáticamente al responder, así que evitá duplicarla.
6. Sé conciso y profesional.
7. El campo "reply" DEBE ser HTML simple válido para un editor enriquecido (usá <p>, <br>, <strong>, <em>, <ul>, <ol>, <li>, <a> cuando corresponda). Si usás un template, preservá su formato HTML y solo adaptá el texto al email. No uses markdown.

Responde ÚNICAMENTE con un objeto JSON con esta estructura exacta:
{
  "stateName": "nombre exacto de la columna del kanban",
  "reply": "<p>respuesta sugerida en HTML</p>",
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
        `\nTEMPLATES DISPONIBLES (relevantes por keywords; el cuerpo es HTML):\n` +
          templates
            .map(
              (t, i) =>
                `[${i + 1}] ID: ${(t._id as Types.ObjectId).toString()}\nNombre: ${t.name}\nContexto: ${t.description}\nRespuesta (HTML): ${t.body}`,
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
