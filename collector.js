import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import express from 'express';

// Configuración de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Express para que Render no apague el servicio
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Quant Sniper Collector - Cloud Active 🚀'));
app.listen(PORT, () => console.log(`🛰️ Servidor de salud en puerto ${PORT}`));

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'];
const INTERVAL = '5m';
const MAX_CANDLES = 50000;
const BATCH_SIZE = 2000; 

// === ESTRATEGIA DE EVASIÓN 451 ===
// Probamos diferentes puertas de entrada de Binance para esquivar el bloqueo regional de Render
const BINANCE_ENDPOINTS = [
    'https://api.binance.com/api/v3',
    'https://api-g.binance.com/api/v3', // Gateway Global (Suele saltar bloqueos)
    'https://api1.binance.com/api/v3',
    'https://api2.binance.com/api/v3',
    'https://api3.binance.com/api/v3'
];
let currentEndpointIdx = 0;

/**
 * Obtiene velas con rotación automática de servidor en caso de bloqueo 451
 */
async function fetchBinance(symbol, limit = 1000, endTime = null) {
    const maxTries = BINANCE_ENDPOINTS.length;
    
    for (let i = 0; i < maxTries; i++) {
        const baseUrl = BINANCE_ENDPOINTS[currentEndpointIdx];
        let url = `${baseUrl}/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${limit}`;
        if (endTime) url += `&endTime=${endTime}`;

        try {
            const res = await axios.get(url, { timeout: 10000 });
            return res.data.map(d => ({
                symbol: symbol,
                interval: INTERVAL,
                timestamp: d[0],
                open: parseFloat(d[1]),
                high: parseFloat(d[2]),
                low: parseFloat(d[3]),
                close: parseFloat(d[4]),
                volume: parseFloat(d[5])
            }));
        } catch (e) {
            const status = e.response?.status;
            if (status === 451) {
                console.warn(`⚠️ [BLOQUEO 451] El endpoint ${baseUrl} bloqueó a Render. Saltando al siguiente...`);
                currentEndpointIdx = (currentEndpointIdx + 1) % BINANCE_ENDPOINTS.length;
                continue; // Intenta con el próximo endpoint
            }
            console.error(`❌ Error en ${baseUrl}: ${e.message}`);
            break; 
        }
    }
    return [];
}

async function syncAsset(symbol) {
    try {
        const { count, error: cErr } = await supabase
            .from('candles')
            .select('*', { count: 'exact', head: true })
            .eq('symbol', symbol);
        
        if (cErr) throw cErr;
        
        let currentCount = count || 0;
        console.log(`[STATUS] ${symbol}: ${currentCount} velas.`);

        if (currentCount < MAX_CANDLES) {
            console.log(`[LLENADO] Descargando bloque histórico para ${symbol}...`);
            let loadedInCycle = 0;
            
            while (loadedInCycle < BATCH_SIZE && currentCount < MAX_CANDLES) {
                const { data: oldest } = await supabase.from('candles')
                    .select('timestamp')
                    .eq('symbol', symbol)
                    .order('timestamp', { ascending: true })
                    .limit(1)
                    .single();

                const endTime = oldest ? oldest.timestamp - 1 : null;
                const historical = await fetchBinance(symbol, 1000, endTime);
                
                if (historical.length === 0) {
                    console.log(`[AVISO] No se pudo obtener más data para ${symbol} en este ciclo.`);
                    break;
                }

                const { error: insErr } = await supabase.from('candles').upsert(historical, { onConflict: 'symbol,timestamp' });
                if (insErr) throw insErr;

                loadedInCycle += historical.length;
                currentCount += historical.length;
                await new Promise(r => setTimeout(r, 400)); 
            }
        }

        // Actualización tiempo real
        const fresh = await fetchBinance(symbol, 20);
        if (fresh.length > 0) await supabase.from('candles').upsert(fresh, { onConflict: 'symbol,timestamp' });

        // Guillotina (Rotación 50k)
        if (currentCount >= MAX_CANDLES) {
            const { data: limit } = await supabase.from('candles').select('timestamp').eq('symbol', symbol).order('timestamp', { ascending: false }).range(MAX_CANDLES, MAX_CANDLES).single();
            if (limit) await supabase.from('candles').delete().eq('symbol', symbol).lt('timestamp', limit.timestamp);
        }

    } catch (err) {
        console.error(`[ERROR] ${symbol}: ${err.message}`);
    }
}

async function run() {
    console.log(`\n[${new Date().toLocaleString()}] 🚀 Ciclo de recolección en la nube...`);
    for (const asset of ASSETS) {
        await syncAsset(asset);
        await new Promise(r => setTimeout(r, 500));
    }
    console.log("✅ Ciclo completado. Esperando 2 minutos...");
}

run();
setInterval(run, 2 * 60 * 1000);
