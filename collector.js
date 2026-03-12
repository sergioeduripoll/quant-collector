import 'dotenv/config';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import express from 'express'; 

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
        // 1. Ver la última vela registrada
        const { data: lastCandle, error: dbError } = await supabase
            .from('candles')
            .select('timestamp')
            .eq('symbol', symbol)
            .eq('interval', INTERVAL)
            .order('timestamp', { ascending: false })
            .limit(1);

        if (dbError) throw dbError;

        // 2. SISTEMA DE AUTO-SANACIÓN: Contar cuántas velas reales existen
        const { count, error: countError } = await supabase
            .from('candles')
            .select('*', { count: 'exact', head: true })
            .eq('symbol', symbol)
            .eq('interval', INTERVAL);

        let startTime;
        
        // Si hay menos de 49.000 velas, ignoramos la última fecha y forzamos la descarga profunda.
        if (count < 49000) {
            console.log(`   [!] ${symbol} tiene solo ${count || 0} velas en DB. Forzando descarga histórica profunda...`);
            startTime = Date.now() - (TARGET_CANDLES * 5 * 60 * 1000);
        } else if (lastCandle && lastCandle.length > 0) {
            startTime = lastCandle[0].timestamp; // Flujo normal: continuar desde la última
        } else {
            startTime = Date.now() - (TARGET_CANDLES * 5 * 60 * 1000);
        }

        let totalSavedInThisSession = 0;
        let keepFetching = true;
        let retries = 0;

        while (keepFetching) {
            const url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=1000&startTime=${Math.floor(startTime) + 1}`;
            
            let res;
            try {
                res = await axios.get(url, { timeout: 15000 });
                retries = 0; 
            } catch (axiosError) {
                console.log(`   [!] Reintentando ${symbol}... (Motivo: ${axiosError.message})`);
                retries++;
                if (retries >= 3) {
                    console.error(`   [X] Abortando descarga de ${symbol} tras 3 fallos.`);
                    break; 
                }
                await new Promise(r => setTimeout(r, 2000)); 
                continue;
            }
            
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
            
            await new Promise(r => setTimeout(r, 300)); 
        }
        console.log(`   [OK] ${symbol} sincronizado (+${totalSavedInThisSession} velas).`);
    } catch (error) {
        console.error(`   [X] Error fatal en ${symbol}:`, error.message);
    }
}

async function runCollector() {
    console.log("\n=========================================");
    console.log("   QUANT SNIPER - CLOUD ENGINE V12.5");
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
