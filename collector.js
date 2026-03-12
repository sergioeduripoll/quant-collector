import 'dotenv/config';
import axios from 'axios';
import { createClient } from '@supabase/supabase-js';
import express from 'express'; 

// --- CONFIGURACIÓN DE SUPABASE ---
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

// --- CONFIGURACIÓN DE ACTIVOS ---
// Ajustamos los símbolos al formato de KuCoin (ej: BTC-USDT)
const ASSETS = [
    'BTC-USDT', 'ETH-USDT', 'ADA-USDT', 'LTC-USDT',
    'SOL-USDT', 'XRP-USDT', 'DOGE-USDT', 'BNB-USDT'
];

// KuCoin usa segundos para los intervalos. 5 min = 300
const INTERVAL = '300'; 
const TARGET_CANDLES = 50000;

// --- SERVIDOR DE "LATIDO" (Para que Render no lo apague) ---
const app = express();
app.get('/', (req, res) => res.send('🚀 QUANT SNIPER COLLECTOR - ACTIVO Y OPERANDO'));
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`[CLOUD] Servidor de latido en puerto ${PORT}`));

async function syncCandlesForAsset(symbol) {
    // Normalizamos el símbolo para la BD de Supabase (sin guión) para mantener la compatibilidad con tu front-end
    const dbSymbol = symbol.replace('-', '');
    
    try {
        // 1. Ver la última vela registrada
        const { data: lastCandle, error: dbError } = await supabase
            .from('candles')
            .select('timestamp')
            .eq('symbol', dbSymbol)
            .eq('interval', '5m') // Mantenemos '5m' en la BD
            .order('timestamp', { ascending: false })
            .limit(1);

        if (dbError) throw dbError;

        // 2. SISTEMA DE AUTO-SANACIÓN
        const { count, error: countError } = await supabase
            .from('candles')
            .select('*', { count: 'exact', head: true })
            .eq('symbol', dbSymbol)
            .eq('interval', '5m');

        let startTime;
        
        if (count < 49000) {
            console.log(`   [!] ${dbSymbol} tiene solo ${count || 0} velas en DB. Forzando descarga histórica profunda...`);
            startTime = Math.floor(Date.now() / 1000) - (TARGET_CANDLES * 5 * 60); // KuCoin usa segundos
        } else if (lastCandle && lastCandle.length > 0) {
            startTime = Math.floor(lastCandle[0].timestamp / 1000); 
        } else {
            startTime = Math.floor(Date.now() / 1000) - (TARGET_CANDLES * 5 * 60);
        }

        let totalSavedInThisSession = 0;
        let keepFetching = true;
        let retries = 0;

        while (keepFetching) {
            // API de KuCoin: Max 1500 velas por petición. Pasamos startAt y endAt
            const endAt = startTime + (1500 * 5 * 60);
            const url = `https://api.kucoin.com/api/v1/market/candles?type=${INTERVAL}&symbol=${symbol}&startAt=${startTime + 1}&endAt=${endAt}`;
            
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
            
            // KuCoin devuelve los datos en res.data.data
            if (!res || !res.data || !res.data.data || res.data.data.length === 0) {
                keepFetching = false;
                break;
            }

            const klines = res.data.data;
            // KuCoin devuelve del más nuevo al más viejo, hay que revertir
            klines.reverse(); 

            const rows = klines.map(c => ({
                symbol: dbSymbol, // Guardamos sin guión para compatibilidad (ej: BTCUSDT)
                interval: '5m',
                timestamp: parseInt(c[0]) * 1000, // Convertir de segundos a milisegundos
                open: parseFloat(c[1]),
                high: parseFloat(c[3]), // En KuCoin el High es el índice 3
                low: parseFloat(c[4]),  // En KuCoin el Low es el índice 4
                close: parseFloat(c[2]),// En KuCoin el Close es el índice 2
                volume: parseFloat(c[5])
            }));

            const { error } = await supabase.from('candles').upsert(rows, { 
                onConflict: 'symbol, interval, timestamp', 
                ignoreDuplicates: true 
            });
            
            if (error) throw error;

            totalSavedInThisSession += rows.length;
            
            // Actualizamos startTime para la siguiente iteración
            startTime = parseInt(klines[klines.length - 1][0]);
            
            if (klines.length < 1500) keepFetching = false;
            
            await new Promise(r => setTimeout(r, 500)); // Límite de KuCoin
        }
        console.log(`   [OK] ${dbSymbol} sincronizado (+${totalSavedInThisSession} velas).`);
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
