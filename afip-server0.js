import express from 'express';
import cors from 'cors';
import fs from 'fs';
import path from 'path';
import { fileURLToPath } from 'url';
import { Arca } from '@arcasdk/core';
import dotenv from 'dotenv';

const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

// .env.local / .env.development / .env (el último no pisa variables ya definidas)
const rootDir = path.join(__dirname, '..');
for (const envFile of ['.env.local', '.env.development', '.env']) {
  dotenv.config({ path: path.join(rootDir, envFile) });
}

const app = express();
const PORT = Number(process.env.AFIP_SERVER_PORT) || 3001;

app.use(cors());
app.use(express.json({ limit: '1mb' }));

/** Comprobantes que discriminan IVA (A y B). */
const CBTE_CON_IVA = new Set([1, 2, 3, 6, 7, 8]);
/** Comprobantes sin IVA (C y equivalentes). */
const CBTE_SIN_IVA = new Set([11, 12, 13]);

let arcaInstance = null;

const initArca = async () => {
  if (arcaInstance) return arcaInstance;

  const CUIT = process.env.VITE_AFIP_CUIT || process.env.AFIP_CUIT;
  const EMPRESA = process.env.VITE_EMPRESA || process.env.AFIP_EMPRESA;

  if (!EMPRESA) {
    throw new Error('Variable VITE_EMPRESA (o AFIP_EMPRESA) no definida. No se encuentra el certificado.');
  }
  if (!CUIT) {
    throw new Error('Variable VITE_AFIP_CUIT (o AFIP_CUIT) no definida.');
  }

  const certPath = path.join(__dirname, 'certs', `${EMPRESA}.crt`);
  const keyPath = path.join(__dirname, 'certs', `${EMPRESA}.key`);

  if (!fs.existsSync(certPath) || !fs.existsSync(keyPath)) {
    throw new Error(`Certificado no encontrado en server/certs/${EMPRESA}.crt o .key`);
  }

  arcaInstance = new Arca({
    enableLogging: process.env.AFIP_DEBUG === '1',
    cuit: CUIT,
    useHttpsAgent: true,
    cert: fs.readFileSync(certPath, 'utf8'),
    key: fs.readFileSync(keyPath, 'utf8'),
  });

  return arcaInstance;
};

const round2 = (n) => Number(parseFloat(n || 0).toFixed(2));

const comprobanteDiscriminaIva = (cbteTipo, calculaivaFlag) => {
  if (CBTE_SIN_IVA.has(cbteTipo)) return false;
  if (CBTE_CON_IVA.has(cbteTipo)) return calculaivaFlag !== false;
  return Boolean(calculaivaFlag);
};

const formatObservaciones = (observaciones) => {
  if (!observaciones?.Obs) return '';
  const items = Array.isArray(observaciones.Obs) ? observaciones.Obs : [observaciones.Obs];
  return items.map((o) => o.Msg || o.msg || `Código ${o.Code}`).filter(Boolean).join(', ');
};

const formatErrorsBlock = (errors) => {
  if (!errors?.Err) return '';
  const items = Array.isArray(errors.Err) ? errors.Err : [errors.Err];
  return items
    .map((e) => {
      const code = e.Code ?? e.code;
      const msg = e.Msg ?? e.msg;
      return code != null ? `[${code}] ${msg}` : msg;
    })
    .filter(Boolean)
    .join(' | ');
};

const extractDetalle = (response) => {
  const root = response?.response ?? response;
  const detalle = root?.FeDetResp?.FECAEDetResponse;
  if (!detalle) return null;
  return Array.isArray(detalle) ? detalle[0] : detalle;
};

/** Mensajes de rechazo: Errors.Err (global) + Observaciones del detalle. */
const extractAfipRejectionMessage = (response, detalle) => {
  const root = response?.response ?? response;
  const parts = [
    formatErrorsBlock(root?.Errors),
    formatObservaciones(detalle?.Observaciones),
  ].filter(Boolean);
  return parts.join(' | ') || '';
};

const getEmisorCuit = () =>
  Number(String(process.env.VITE_AFIP_CUIT || process.env.AFIP_CUIT || '').replace(/\D/g, ''));

const appendLog = (section, payload) => {
  const logFile = path.join(__dirname, 'afip-logs.txt');
  try {
    const timestamp = new Date().toLocaleString('es-AR');
    const logEntry = `[${timestamp}]\n=== ${section} ===\n${
      typeof payload === 'string' ? payload : JSON.stringify(payload, null, 2)
    }\n------------------------------------------------------------\n\n`;
    const existing = fs.existsSync(logFile) ? fs.readFileSync(logFile, 'utf8') : '';
    fs.writeFileSync(logFile, logEntry + existing, 'utf8');
  } catch (logErr) {
    console.error('Error escribiendo log de AFIP:', logErr);
  }
};

/**
 * Arma el request WSFE según tipo de comprobante y flags del front.
 * Reglas AFIP resumidas:
 * - Factura C (11/12/13): ImpIVA=0, ImpNeto=ImpTotal, sin bloque Iva.
 * - Factura A/B con IVA: ImpTotal = ImpNeto + ImpIVA, bloque Iva obligatorio si ImpIVA > 0.
 */
function buildVoucherRequest(data, nextNumber, now) {
  const ptoVta = Number(data.ptoVta) || 1;
  const cbteTipo = Number(data.comprobante);
  const total = round2(data.total);
  let neto = round2(data.neto);
  let iva = round2(data.iva);

  const discrimina = comprobanteDiscriminaIva(cbteTipo, data.calculaiva);
  let ivaList = (data.ivaList || []).filter((i) => i && (i.Importe > 0 || i.BaseImp > 0));

  if (!discrimina) {
    neto = total;
    iva = 0;
    ivaList = [];
  } else if (ivaList.length > 0) {
    ivaList = ivaList.map((i) => ({
      Id: Number(i.Id),
      BaseImp: round2(i.BaseImp),
      Importe: round2(i.Importe),
    }));
    const sumNeto = round2(ivaList.reduce((s, i) => s + i.BaseImp, 0));
    const sumIva = round2(ivaList.reduce((s, i) => s + i.Importe, 0));
    neto = sumNeto;
    iva = sumIva;
  }

  const impTotalCalc = round2(neto + iva);
  if (Math.abs(impTotalCalc - total) > 0.02) {
    throw new Error(
      `Montos inconsistentes: total=${total}, neto+iva=${impTotalCalc} (neto=${neto}, iva=${iva}).`
    );
  }

  if (discrimina && iva > 0 && ivaList.length === 0) {
    throw new Error('Falta el detalle de alícuotas IVA (ivaList) para este comprobante.');
  }

  const docTipo = Number(data.docTipo) || 99;
  const docNro = Number(data.documento) || 0;
  const condicionIva = Number(data.condicionIva) || 5;

  if (docTipo === 80 && String(docNro).length !== 11) {
    throw new Error('CUIT inválido: debe tener 11 dígitos numéricos.');
  }

  const cuitEmisor = getEmisorCuit();
  if (docTipo === 80 && docNro > 0 && cuitEmisor > 0 && docNro === cuitEmisor) {
    throw new Error(
      '[10069] El documento del receptor no puede ser igual al CUIT del emisor.'
    );
  }

  const voucherRequest = {
    CantReg: 1,
    PtoVta: ptoVta,
    CbteTipo: cbteTipo,
    Concepto: 1,
    DocTipo: docTipo,
    DocNro: docNro,
    CbteDesde: nextNumber,
    CbteHasta: nextNumber,
    CbteFch: now,
    ImpTotal: total,
    ImpTotConc: 0,
    ImpNeto: neto,
    ImpOpEx: 0,
    ImpIVA: discrimina ? iva : 0,
    ImpTrib: 0,
    MonId: 'PES',
    MonCotiz: 1,
    CondicionIVAReceptorId: condicionIva,
    CondicionIVAReceptorIdSpecified: true,
  };

  if (discrimina && iva > 0 && ivaList.length > 0) {
    voucherRequest.Iva = ivaList;
  }

  return voucherRequest;
}

// Comprobante electrónico (A, B, C, NC, ND…) según CbteTipo del front
app.post('/afip/invoice/b', async (req, res) => {
  let voucherRequest;

  try {
    const arca = await initArca();
    const data = req.body || {};

    const ptoVta = Number(data.ptoVta);
    const cbteTipo = Number(data.comprobante);

    if (!Number.isFinite(ptoVta) || ptoVta < 1 || ptoVta > 9999) {
      return res.status(400).json({ error: 'Punto de venta (ptoVta) inválido.' });
    }
    if (!Number.isFinite(cbteTipo) || cbteTipo <= 0) {
      return res.status(400).json({ error: 'Tipo de comprobante (comprobante / CbteTipo) inválido.' });
    }
    if (!Number.isFinite(Number(data.total)) || Number(data.total) <= 0) {
      return res.status(400).json({ error: 'El importe total debe ser mayor a cero.' });
    }

    const lastVoucher = await arca.electronicBillingService.getLastVoucher(ptoVta, cbteTipo);
    const nextNumber = (lastVoucher?.cbteNro ?? 0) + 1;

    console.log(
      `PV ${ptoVta} · CbteTipo ${cbteTipo} · último ${lastVoucher?.cbteNro ?? 0} · próximo ${nextNumber}`
    );

    const now = new Date().toISOString().replaceAll('-', '').substring(0, 8);
    voucherRequest = buildVoucherRequest(data, nextNumber, now);

    const response = await arca.electronicBillingService.createVoucher(voucherRequest);
    appendLog('REQUEST / RESPONSE', { request: voucherRequest, response });

    const result = extractDetalle(response);
    if (!result) {
      return res.status(502).json({ error: 'AFIP respondió sin detalle de comprobante (FECAEDetResponse).' });
    }

    const rejectionMsg = extractAfipRejectionMessage(response, result);
    const obs = formatObservaciones(result.Observaciones) || rejectionMsg;
    const cabResultado = response?.response?.FeCabResp?.Resultado;

    if (result.Resultado !== 'A' || cabResultado === 'R') {
      const detalle = rejectionMsg || `Resultado detalle: ${result.Resultado}`;
      return res.status(400).json({
        error: detalle ? `AFIP rechazó la factura: ${detalle}` : 'AFIP rechazó la factura.',
        resultado: result.Resultado,
        resultadoCabecera: cabResultado,
        observaciones: obs,
        errors: rejectionMsg,
      });
    }

    res.json({
      cae: result.CAE,
      vto: result.CAEFchVto,
      numero: nextNumber,
      puntoVenta: ptoVta,
      comprobante: cbteTipo,
      observaciones: obs || undefined,
    });
  } catch (error) {
    console.error('Error generating AFIP invoice:', error);
    appendLog('ERROR', {
      message: error.message || String(error),
      request: voucherRequest || req.body,
    });

    const status = error.message?.includes('Montos inconsistentes') ||
      error.message?.includes('inválido') ||
      error.message?.includes('Falta el detalle')
      ? 400
      : 500;

    res.status(status).json({
      error: error.message || 'Error interno del servidor al procesar la factura',
    });
  }
});

app.get('/afip/health', async (_req, res) => {
  try {
    const arca = await initArca();
    res.json({
      ok: true,
      cuit: process.env.VITE_AFIP_CUIT || process.env.AFIP_CUIT,
      empresa: process.env.VITE_EMPRESA || process.env.AFIP_EMPRESA,
      sdk: Boolean(arca),
    });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});

app.get('/afip/certs', (_req, res) => {
  res.status(404).json({ error: 'Endpoint obsoleto. Los certificados se usan solo en el servidor.' });
});

app.get('/health', (req, res) => {
  res.status(200).json({
    status: 'ok',    
    cuit: process.env.VITE_AFIP_CUIT || process.env.AFIP_CUIT,
    empresa: process.env.VITE_EMPRESA || process.env.AFIP_EMPRESA,
    timestamp: new Date().toISOString()
  })
})

app.listen(PORT, () => {
  console.log(`AFIP Server en http://localhost:${PORT}`);
});
