import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import express from 'express';

// Configuración de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Servidor Express para salud y evitar el "spin down" de Render
const app = express();
const PORT = process.env.PORT || 3000;
app.get('/', (req, res) => res.send('Quant Collector (KuCoin Mode) Activo 🚀'));
app.listen(PORT, () => console.log(`🛰️ Monitor en puerto ${PORT} - Usando KuCoin API`));

// Configuración de Activos y Límites
const ASSETS = ['BTC-USDT', 'ETH-USDT', 'ADA-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'BNB-USDT'];
const INTERVAL = '5min'; 
const MAX_CANDLES = 50000;
const BATCH_SIZE = 1500; 

/**
 * Obtiene velas de KuCoin con manejo de Rate Limit (429)
 */
async function fetchKucoin(symbol, startAt = null, endAt = null) {
    try {
        let url = `https://api.kucoin.com/api/v1/market/candles?symbol=${symbol}&type=${INTERVAL}`;
        if (startAt) url += `&startAt=${Math.floor(startAt / 1000)}`;
        if (endAt) url += `&endAt=${Math.floor(endAt / 1000)}`;
        
        const res = await axios.get(url, { timeout: 15000 });
        
        if (!res.data || !res.data.data) return [];

        // Mapeo al formato compatible con el Backend y Supabase
        return res.data.data.map(d => ({
            symbol: symbol.replace('-', ''), // Guardamos BTCUSDT
            interval: '5m',
            timestamp: parseInt(d[0]) * 1000, 
            open: parseFloat(d[1]),
            close: parseFloat(d[2]),
            high: parseFloat(d[3]),
            low: parseFloat(d[4]),
            volume: parseFloat(d[5])
        }));
    } catch (e) {
        if (e.response?.status === 429) {
            console.warn(`⏳ [Rate Limit] KuCoin pidió un respiro. Esperando 10s...`);
            await new Promise(r => setTimeout(r, 10000));
        } else {
            console.error(`❌ Error en ${symbol}: ${e.message}`);
        }
        return [];
    }
}

/**
 * Sincronización inteligente por activo
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
        console.log(`[STATUS] ${dbSymbol}: ${currentCount} velas registradas.`);

        // 1. LLENADO HISTÓRICO (Hacia atrás)
        if (currentCount < MAX_CANDLES) {
            const { data: oldest } = await supabase
                .from('candles')
                .select('timestamp')
                .eq('symbol', dbSymbol)
                .order('timestamp', { ascending: true })
                .limit(1)
                .single();

            // Si hay velas, pedimos lo anterior a la más vieja. Si no, empezamos desde ahora.
            const endAt = oldest ? oldest.timestamp - 1 : Date.now();
            const historical = await fetchKucoin(symbol, null, endAt);
            
            if (historical.length > 0) {
                // CORRECCIÓN CRÍTICA: onConflict debe incluir 'interval' para coincidir con la Primary Key de la tabla
                const { error: insErr } = await supabase.from('candles').upsert(historical, { onConflict: 'symbol,interval,timestamp' });
                if (insErr) throw insErr;
                console.log(`[OK] ${dbSymbol}: Se sumaron ${historical.length} velas históricas.`);
            }
        }

        // 2. ACTUALIZACIÓN EN VIVO (Velas nuevas)
        const fresh = await fetchKucoin(symbol);
        if (fresh.length > 0) {
            // CORRECCIÓN CRÍTICA: onConflict debe incluir 'interval'
            await supabase.from('candles').upsert(fresh.slice(0, 50), { onConflict: 'symbol,interval,timestamp' });
        }

        // 3. PURGA (Límite 50k)
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
        console.error(`[ERROR CRÍTICO] ${dbSymbol}: ${err.message}`);
    }
}

async function run() {
    console.log(`\n[${new Date().toLocaleString()}] 🚀 Iniciando ciclo KuCoin (Plan B)...`);
    for (const asset of ASSETS) {
        await syncAsset(asset);
        await new Promise(r => setTimeout(r, 1000)); 
    }
    console.log("✅ Ciclo de lote completado. Esperando 2 minutos...");
}

// Arrancar proceso
run();
setInterval(run, 2 * 60 * 1000);
