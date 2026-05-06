import fs from 'fs';
import path from 'path';
import type * as t from './types';
import { planLimits, languageConfig, resolveLanguage } from './config';

export const templateCode = fs.readFileSync(path.join(__dirname, 'matplotlib.py'), 'utf8');

export function createPayload({
  req,
  isPyPlot,
  session_id,
}: t.CreatePayload): t.PayloadBody {
  const { lang: rawLang, code: userCode, args, files } = req.body as t.RequestBody;
  const language = resolveLanguage(rawLang);
  if (language === undefined) {
    throw new Error(`Unsupported language: ${rawLang}`);
  }
  const config = languageConfig[language];
  if (config === undefined) {
    throw new Error(`Unsupported language: ${rawLang}`);
  }

  let finalCode: string;
  if (isPyPlot === true) {
    const indentedUserCode = userCode.trim().split('\n').map(line => `    ${line}`).join('\n');
    finalCode = templateCode.replace(
      /# BEGIN USER CODE\n[\s\S]*?# END USER CODE/,
      `# BEGIN USER CODE\n${indentedUserCode}\n    # END USER CODE`
    );
  } else {
    finalCode = userCode;
  }

  const run_memory_limit = planLimits[req.planId ?? '']?.run_memory_limit ?? planLimits.default.run_memory_limit;
  const payload: t.PayloadBody = {
    run_memory_limit,
    language: config.language,
    version: config.version,
    files: [
      {
        name: config.fileName,
        content: finalCode
      }
    ]
  };

  if (session_id) {
    payload.session_id = session_id;
  }

  if (args) {
    payload.args = args;
  }

  if (files && files.length > 0) {
    files.forEach(obj => {
      /* `entity_id` flows through to the worker's TFile so it can be
       * echoed back on `inherited: true` files. Caller (LibreChat) needs
       * the round-trip to survive — without it, the next execute in the
       * same session injects unscoped files and 403s under per-file
       * authorization. */
      payload.files.push({
        id: obj.id,
        session_id: obj.session_id,
        name: obj.name,
        ...(obj.entity_id !== undefined ? { entity_id: obj.entity_id } : {}),
      });
    });
  }

  return payload;
}