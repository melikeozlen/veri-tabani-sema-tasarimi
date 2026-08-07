import { google } from 'googleapis';
import { env } from './env.js';

const auth = new google.auth.JWT({
  email: env.serviceAccount.client_email,
  key: env.serviceAccount.private_key,
  scopes: [
    'https://www.googleapis.com/auth/spreadsheets',
    // Super admin diyagram kaydı için yazma gerekir (klasörler Editor paylaşılmalı).
    'https://www.googleapis.com/auth/drive',
  ],
});

export const sheets = google.sheets({ version: 'v4', auth });
export const drive = google.drive({ version: 'v3', auth });
