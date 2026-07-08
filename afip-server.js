
import express from 'express';
import cors from 'cors';
import { Arca } from '@arcasdk/core';
import dotenv from 'dotenv';
import PocketBase from 'pocketbase';

// En desarrollo cargamos .env, en Render esto no hace nada y está bien.
dotenv.config();

const app = express();
const PORT = process.env.PORT || 3001; // Render asigna el puerto mediante la variable PORT

app.use(cors());
app.use(express.json({ limit: '1mb' }));

// Configuración de PocketBase
const pb = new PocketBase(process.env.VITE_PB_ADDRESS || process.env.POCKETBASE_URL);

/** Comprobantes que discriminan IVA (A y B). */
const CBTE_CON_IVA = new Set([1, 2, 3, 6, 7, 8]);
const CBTE_SIN_IVA = new Set([11, 12, 13]);

let arcaInstance = null;

const initArca = async () => {
  if (arcaInstance) return arcaInstance;

  // Se asume que el admin ya está autenticado en PB o es público
  const record = await pb.collection('afip_certs').getFirstListItem();

  if (!record?.cert || !record?.key) {
    throw new Error(`Certificado no encontrado en PocketBase`);
  }

  arcaInstance = new Arca({
    enableLogging: process.env.AFIP_DEBUG === '1',
    cuit: record.cuit,
    useHttpsAgent: true,
    cert: record.cert,
    key: record.key,
  });

  return arcaInstance;
};

// --- Helpers ---
const round2 = (n) => Number(parseFloat(n || 0).toFixed(2));
const comprobanteDiscriminaIva = (cbteTipo, calculaivaFlag) => {
  if (CBTE_SIN_IVA.has(cbteTipo)) return false;
  if (CBTE_CON_IVA.has(cbteTipo)) return calculaivaFlag !== false;
  return Boolean(calculaivaFlag);
};

const formatObservaciones = (obs) => obs?.Obs ? (Array.isArray(obs.Obs) ? obs.Obs : [obs.Obs]).map(o => o.Msg || o.msg).join(', ') : '';

const formatErrorsBlock = (errs) => errs?.Err ? (Array.isArray(errs.Err) ? errs.Err : [errs.Err]).map(e => `[${e.Code || e.code}] ${e.Msg || e.msg}`).join(' | ') : '';

const extractDetalle = (resp) => (resp?.response?.FeDetResp?.FECAEDetResponse ?
  (Array.isArray(resp.response.FeDetResp.FECAEDetResponse) ? resp.response.FeDetResp.FECAEDetResponse[0] : resp.response.FeDetResp.FECAEDetResponse) : null);

const getEmisorCuit = () => Number(String(process.env.VITE_AFIP_CUIT || process.env.AFIP_CUIT || '').replace(/\D/g, ''));

// --- Rutas ---

app.post('/afip/invoice/b', async (req, res) => {
  try {
    const arca = await initArca();
    const data = req.body;
    const ptoVta = Number(data.ptoVta);
    const cbteTipo = Number(data.comprobante);

    const lastVoucher = await arca.electronicBillingService.getLastVoucher(ptoVta, cbteTipo);
    const nextNumber = (lastVoucher?.cbteNro ?? 0) + 1;
    const now = new Date().toISOString().replaceAll('-', '').substring(0, 8);

    // ... (aquí iría tu lógica de buildVoucherRequest, simplificada para el ejemplo)
    const voucherRequest = buildVoucherRequest(data, nextNumber, now);

    const response = await arca.electronicBillingService.createVoucher(voucherRequest);

    // Logs enviados a consola estándar (Render los captura automáticamente)
    console.log("AFIP Response:", JSON.stringify(response));

    const result = extractDetalle(response);
    if (result?.Resultado !== 'A') {
      return res.status(400).json({ error: 'AFIP rechazó la factura', details: formatErrorsBlock(response?.response?.Errors) });
    }

    res.json({ cae: result.CAE, vto: result.CAEFchVto, numero: nextNumber });
  } catch (error) {
    console.error('AFIP Error:', error);
    res.status(500).json({ error: error.message });
  }
});


app.get('/afip/health', async (_req, res) => {
  try {
    await initArca();
    const record1 = await pb.collection('afip_certs').getFirstListItem();
    console.log('certs:', record1);
    res.json({ ok: true });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message, errorString: error });
  }
});
app.get('/', async (_req, res) => {


  res.json({ ok: true, pb: process.env.POCKETBASE_URL || "-- sin pb --" });

});




app.get('/afip/getcerts', async (_req, res) => {
  try {
    const record1 = await pb.collection('afip_certs').getFirstListItem();
    res.json({ ok: record1 });
  } catch (error) {
    res.status(503).json({ ok: false, error: error.message });
  }
});


app.get('/health', (req, res) => res.status(200).json({ status: 'ok' }));

app.listen(PORT, () => {
  console.log(`AFIP Server corriendo en puerto ${PORT}`);
});