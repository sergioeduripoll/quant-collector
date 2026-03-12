import 'dotenv/config';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import express from 'express'; // Agregamos un servidor web mínimo

// --- CONFIGURACIÓN DE SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CONFIGURACIÓN DE ACTIVOS ---
const ASSETS = [
    'BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'LTCUSDT',
    'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'
];
const INTERVAL = '5m';
const TARGET_CANDLES = 50000;

// --- SERVIDOR DE "LATIDO" (Para que Render no lo apague) ---
const app = express();
app.get('/', (req, res) => res.send('🚀 QUANT SNIPER COLLECTOR - ACTIVO Y OPERANDO'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[CLOUD] Servidor de latido en puerto ${PORT}`));

async function syncCandlesForAsset(symbol) {
    try {
        const { data: lastCandle } = await supabase
            .from('candles')
            .select('timestamp')
            .eq('symbol', symbol)
            .eq('interval', INTERVAL)
            .order('timestamp', { ascending: false })
            .limit(1);

        let startTime = lastCandle && lastCandle.length > 0 
            ? lastCandle[0].timestamp 
            : (Date.now() - (180 * 24 * 60 * 60 * 1000)); 

        let totalSavedInThisSession = 0;
        let keepFetching = true;

        while (keepFetching) {
            const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=1000&startTime=${startTime + 1}`;
            const res = await axios.get(url).catch(() => null);
            
            if (!res || !res.data || res.data.length === 0) break;

            const klines = res.data;
            const rows = klines.map(c => ({
                symbol,
                interval: INTERVAL,
                timestamp: c[0],
                open: parseFloat(c[1]),
                high: parseFloat(c[2]),
                low: parseFloat(c[3]),
                close: parseFloat(c[4]),
                volume: parseFloat(c[5])
            }));

            const { error } = await supabase.from('candles').upsert(rows, { 
                onConflict: 'symbol, interval, timestamp', 
                ignoreDuplicates: true 
            });
            
            if (error) throw error;

            totalSavedInThisSession += rows.length;
            startTime = klines[klines.length - 1][0];
            if (klines.length < 1000) keepFetching = false;
            
            await new Promise(r => setTimeout(r, 200)); 
        }
        console.log(`   [OK] ${symbol} sincronizado (+${totalSavedInThisSession} velas).`);
    } catch (error) {
        console.error(`   [X] Error en ${symbol}:`, error.message);
    }
}

async function runCollector() {
    console.log("\n=========================================");
    console.log("   QUANT SNIPER - CLUD ENGINE V12.5");
    console.log(`   ${new Date().toLocaleString()}`);
    console.log("=========================================");

    for (const asset of ASSETS) {
        await syncCandlesForAsset(asset);
    }

    console.log("\n✅ CICLO COMPLETADO. Esperando 5 min...");
    setTimeout(runCollector, 5 * 60 * 1000);
}

// Arrancar el motor
runCollector();
