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
app.listen(PORT, () => console.log(`🛰️ Monitor en puerto ${PORT} - Evasión de conflictos activa`));

// Configuración de Activos y Límites
const ASSETS = ['BTC-USDT', 'ETH-USDT', 'ADA-USDT', 'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'BNB-USDT'];
const INTERVAL = '5min'; 
const MAX_CANDLES = 50000;
const BATCH_SIZE = 1500; 

/**
 * Obtiene velas de KuCoin
 */
async function fetchKucoin(symbol, startAt = null, endAt = null) {
    try {
        let url = `https://api.kucoin.com/api/v1/market/candles?symbol=${symbol}&type=${INTERVAL}&limit=${BATCH_SIZE}`;
        if (startAt) url += `&startAt=${Math.floor(startAt / 1000)}`;
        if (endAt) url += `&endAt=${Math.floor(endAt / 1000)}`;
        
        const res = await axios.get(url, { timeout: 15000 });
        
        if (!res.data || !res.data.data) return [];

        return res.data.data.map(d => ({
            symbol: symbol.replace('-', ''), 
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
            console.warn(`⏳ [Rate Limit] KuCoin pidió un respiro.`);
            await new Promise(r => setTimeout(r, 10000));
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
        console.log(`[STATUS] ${dbSymbol}: ${currentCount} velas.`);

        // 1. LLENADO HISTÓRICO (Solo si falta data)
        if (currentCount < MAX_CANDLES) {
            const { data: oldest } = await supabase
                .from('candles')
                .select('timestamp')
                .eq('symbol', dbSymbol)
                .order('timestamp', { ascending: true })
                .limit(1)
                .single();

            const endAt = oldest ? oldest.timestamp - 1 : Date.now();
            const historical = await fetchKucoin(symbol, null, endAt);
            
            if (historical.length > 0) {
                // USANDO LA LLAVE EXACTA DE TU TABLA: symbol,interval,timestamp
                const { error: insErr } = await supabase.from('candles')
                    .upsert(historical, { onConflict: 'symbol,interval,timestamp' });
                
                if (insErr) {
                    console.error(`❌ Error en Upsert ${dbSymbol}: ${insErr.message}`);
                } else {
                    console.log(`[OK] ${dbSymbol}: +${historical.length} velas históricas.`);
                }
            }
        }

        // 2. ACTUALIZACIÓN EN VIVO
        const fresh = await fetchKucoin(symbol);
        if (fresh.length > 0) {
            await supabase.from('candles')
                .upsert(fresh.slice(0, 50), { onConflict: 'symbol,interval,timestamp' });
        }

        // 3. PURGA (Límite 50k)
        if (currentCount > (MAX_CANDLES + 2000)) {
            const { data: threshold } = await supabase
                .from('candles')
                .select('timestamp')
                .eq('symbol', dbSymbol)
                .order('timestamp', { ascending: false })
                .range(MAX_CANDLES, MAX_CANDLES)
                .single();

            if (threshold) {
                await supabase.from('candles').delete().eq('symbol', dbSymbol).lt('timestamp', threshold.timestamp);
                console.log(`[PURGA] ${dbSymbol} limpia.`);
            }
        }

    } catch (err) {
        console.error(`[FATAL] ${dbSymbol}: ${err.message}`);
    }
}

async function run() {
    console.log(`\n[${new Date().toLocaleString()}] 🚀 Ciclo KuCoin iniciado...`);
    for (const asset of ASSETS) {
        await syncAsset(asset);
        await new Promise(r => setTimeout(r, 1500)); 
    }
    console.log("✅ Ciclo de lote completado.");
}

run();
setInterval(run, 2 * 60 * 1000);
