import { Injectable } from '@nestjs/common';
import { ConfigService } from '@nestjs/config';
import * as crypto from 'crypto';

const ALGORITHM = 'aes-256-cbc';
const IV_LENGTH = 16;

@Injectable()
export class EncryptionService {
  private readonly key: Buffer;

  constructor(config: ConfigService) {
    const rawKey = config.get<string>('ENCRYPTION_KEY') ?? '';
    if (rawKey.length !== 32) {
      throw new Error('ENCRYPTION_KEY debe tener exactamente 32 caracteres');
    }
    this.key = Buffer.from(rawKey, 'utf8');
  }

  encrypt(text: string): string {
    const iv = crypto.randomBytes(IV_LENGTH);
    const cipher = crypto.createCipheriv(ALGORITHM, this.key, iv);
    const encrypted = Buffer.concat([cipher.update(text, 'utf8'), cipher.final()]);
    return `${iv.toString('hex')}:${encrypted.toString('hex')}`;
  }

  decrypt(encryptedText: string): string {
    const [ivHex, encryptedHex] = encryptedText.split(':');
    const iv = Buffer.from(ivHex, 'hex');
    const encrypted = Buffer.from(encryptedHex, 'hex');
    const decipher = crypto.createDecipheriv(ALGORITHM, this.key, iv);
    return Buffer.concat([decipher.update(encrypted), decipher.final()]).toString('utf8');
  }
}
