import { Injectable, Logger } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import OpenAI from 'openai';

@Injectable()
export class OpenAiService {
  private readonly logger = new Logger(OpenAiService.name);
  private readonly client: OpenAI | null;
  private readonly model: string;

  constructor(private readonly config: ConfigService) {
    const apiKey = config.get<string>('OPENAI_API_KEY');
    this.model = config.get<string>('OPENAI_MODEL') ?? 'gpt-4o';

    if (apiKey) {
      this.client = new OpenAI({ apiKey });
    } else {
      this.logger.warn('OPENAI_API_KEY no configurado — módulo de IA deshabilitado');
      this.client = null;
    }
  }

  get isEnabled(): boolean {
    return this.client !== null;
  }

  /**
   * Solicita una respuesta JSON estructurada a OpenAI.
   * Retorna null si la IA no está configurada o si ocurre un error.
   */
  async chatJson<T>(
    systemPrompt: string,
    userPrompt: string,
  ): Promise<T | null> {
    if (!this.client) return null;

    try {
      const response = await this.client.chat.completions.create({
        model: this.model,
        response_format: { type: 'json_object' },
        messages: [
          { role: 'system', content: systemPrompt },
          { role: 'user', content: userPrompt },
        ],
        temperature: 0.3,
        max_tokens: 1500,
      });

      const content = response.choices[0]?.message?.content ?? '{}';
      return JSON.parse(content) as T;
    } catch (err) {
      this.logger.error('Error llamando a OpenAI:', err);
      return null;
    }
  }
}
