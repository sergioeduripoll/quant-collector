import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import express from 'express';

// Configuración de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Express para que Render vea actividad web y no apague el proceso
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Quant Collector (KuCoin Mode) Operativo 🚀'));
app.listen(PORT, () => console.log(`🛰️ Monitor activo en puerto ${PORT} - Usando KuCoin API`));

// KuCoin usa el formato ASSET-USDT
const ASSETS = ['BTC-USDT', 'ETH-USDT', 'ADA-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'BNB-USDT'];
const INTERVAL = '5min'; // KuCoin usa '5min' en lugar de '5m'
const MAX_CANDLES = 50000;
const BATCH_SIZE = 1500; // KuCoin permite hasta 1500 velas por petición

/**
 * Obtiene velas de KuCoin API
 * Formato respuesta KuCoin: [time, open, close, high, low, volume, turnover]
 */
async function fetchKucoin(symbol, startAt = null) {
    try {
        let url = `https://api.kucoin.com/api/v1/market/candles?symbol=${symbol}&type=${INTERVAL}`;
        if (startAt) {
            // KuCoin pide segundos, no milisegundos
            url += `&startAt=${Math.floor(startAt / 1000)}`;
        }
        
        const res = await axios.get(url, { timeout: 15000 });
        
        if (!res.data || !res.data.data) return [];

        // KuCoin devuelve las velas de la más nueva a la más vieja
        return res.data.data.map(d => ({
            symbol: symbol.replace('-', ''), // Guardamos como BTCUSDT para que sea compatible con el resto del sistema
            interval: '5m',
            timestamp: parseInt(d[0]) * 1000, // Convertimos a milisegundos
            open: parseFloat(d[1]),
            close: parseFloat(d[2]),
            high: parseFloat(d[3]),
            low: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));
    } catch (e) {
        console.error(`⚠️ Error de KuCoin en ${symbol}: ${e.message}`);
        return [];
    }
}

/**
 * Sincronización con Llenado Progresivo (KuCoin Edition)
 */
async function syncAsset(symbol) {
    const dbSymbol = symbol.replace('-', '');
    try {
        const { count, error: cErr } = await supabase
            .from('candles')
            .select('*', { count: 'exact', head: true })
            .eq('symbol', dbSymbol);
        
        if (cErr) throw cErr;
        
        let currentCount = count || 0;
        console.log(`[STATUS] ${dbSymbol}: ${currentCount} velas en DB.`);

        // 1. LLENADO PROFUNDO
        if (currentCount < MAX_CANDLES) {
            console.log(`[LLENADO] Descargando bloque de KuCoin para ${dbSymbol}...`);
            
            const { data: oldest } = await supabase
                .from('candles')
                .select('timestamp')
                .eq('symbol', dbSymbol)
                .order('timestamp', { ascending: true })
                .limit(1)
                .single();

            // KuCoin permite pedir data histórica usando startAt y endAt
            // Para ir hacia atrás, calculamos un bloque anterior al más viejo que tenemos
            const pivotTime = oldest ? oldest.timestamp : Date.now();
            const startTime = pivotTime - (BATCH_SIZE * 5 * 60 * 1000); 

            const historical = await fetchKucoin(symbol, startTime);
            
            if (historical.length > 0) {
                const { error: insErr } = await supabase.from('candles').upsert(historical, { onConflict: 'symbol,timestamp' });
                if (insErr) throw insErr;
                console.log(`[OK] ${dbSymbol} sumó ${historical.length} velas del pasado.`);
            }
        }

        // 2. UPDATE TIEMPO REAL
        const fresh = await fetchKucoin(symbol);
        if (fresh.length > 0) {
            await supabase.from('candles').upsert(fresh.slice(0, 50), { onConflict: 'symbol,timestamp' });
        }

        // 3. MANTENIMIENTO (Guillotina 50k)
        if (currentCount >= MAX_CANDLES) {
            const { data: threshold } = await supabase
                .from('candles')
                .select('timestamp')
                .eq('symbol', dbSymbol)
                .order('timestamp', { ascending: false })
                .range(MAX_CANDLES, MAX_CANDLES)
                .single();

            if (threshold) {
                await supabase.from('candles').delete().eq('symbol', dbSymbol).lt('timestamp', threshold.timestamp);
            }
        }

    } catch (err) {
        console.error(`[ERROR] ${dbSymbol}: ${err.message}`);
    }
}

async function run() {
    console.log(`\n[${new Date().toLocaleString()}] 🚀 Iniciando ciclo KuCoin...`);
    for (const asset of ASSETS) {
        await syncAsset(asset);
        await new Promise(r => setTimeout(r, 1000)); // Respiro para KuCoin
    }
    console.log("✅ Lote completado. KuCoin es mucho más rápido. Próximo ciclo en 2 min...");
}

run();
setInterval(run, 2 * 60 * 1000);
