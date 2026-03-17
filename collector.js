import 'dotenv/config';
import { createClient } from '@supabase/supabase-js';
import axios from 'axios';
import express from 'express';

// Configuración de Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_KEY);

// Configuración de Express para mantener vivo el servicio en Render
const app = express();
const PORT = process.env.PORT || 3000;

app.get('/', (req, res) => res.send('Quant Collector Operativo 🚀'));
app.listen(PORT, () => console.log(`🛰️ Servidor de salud activo en puerto ${PORT}`));

const ASSETS = ['BTCUSDT', 'ETHUSDT', 'ADAUSDT', 'SOLUSDT', 'XRPUSDT', 'DOGEUSDT', 'BNBUSDT'];
const INTERVAL = '5m';
const MAX_CANDLES = 50000;
const BATCH_SIZE = 2000; 

/**
 * Obtiene velas de Binance con manejo de errores y límites
 */
async function fetchBinance(symbol, limit = 1000, endTime = null) {
    try {
        let url = `https://api.binance.com/api/v3/klines?symbol=${symbol}&interval=${INTERVAL}&limit=${limit}`;
        if (endTime) url += `&endTime=${endTime}`;
        const res = await axios.get(url);
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
        console.error(`⚠️ Error de Binance en ${symbol}: ${e.message}`);
        return [];
    }
}

/**
 * Sincroniza un activo: Llenado progresivo + Update + Purga
 */
async function syncAsset(symbol) {
    try {
        // 1. Conteo exacto en Supabase
        const { count, error: cErr } = await supabase
            .from('candles')
            .select('*', { count: 'exact', head: true })
            .eq('symbol', symbol);
        
        if (cErr) throw cErr;
        console.log(`[STATUS] ${symbol}: ${count || 0} velas registradas.`);

        let currentCount = count || 0;

        // 2. Llenado Progresivo (BATCH_SIZE) para evitar timeouts en Render
        if (currentCount < MAX_CANDLES) {
            console.log(`[LLENADO] Recuperando historial para ${symbol}...`);
            let loadedInThisCycle = 0;
            
            while (loadedInThisCycle < BATCH_SIZE && currentCount < MAX_CANDLES) {
                const { data: oldest } = await supabase
                    .from('candles')
                    .select('timestamp')
                    .eq('symbol', symbol)
                    .order('timestamp', { ascending: true })
                    .limit(1)
                    .single();

                const endTime = oldest ? oldest.timestamp - 1 : null;
                
                const historical = await fetchBinance(symbol, 1000, endTime);
                if (historical.length === 0) break;

                const { error: insErr } = await supabase.from('candles').upsert(historical, { onConflict: 'symbol,timestamp' });
                if (insErr) throw insErr;

                loadedInThisCycle += historical.length;
                currentCount += historical.length;
                // Pequeño respiro para la API de Binance
                await new Promise(r => setTimeout(r, 300)); 
            }
            console.log(`[HISTÓRICO] ${symbol} alcanzó ${currentCount} velas.`);
        }

        // 3. Actualización de tiempo real (Velas más nuevas)
        const fresh = await fetchBinance(symbol, 50);
        if (fresh.length > 0) {
            await supabase.from('candles').upsert(fresh, { onConflict: 'symbol,timestamp' });
        }

        // 4. Mantenimiento (Ventana Deslizante de 50k)
        if (currentCount >= MAX_CANDLES) {
            const { data: threshold } = await supabase
                .from('candles')
                .select('timestamp')
                .eq('symbol', symbol)
                .order('timestamp', { ascending: false })
                .range(MAX_CANDLES, MAX_CANDLES)
                .single();

            if (threshold) {
                await supabase
                    .from('candles')
                    .delete()
                    .eq('symbol', symbol)
                    .lt('timestamp', threshold.timestamp);
                console.log(`[PURGA] ${symbol}: Base de datos rotada correctamente.`);
            }
        }

    } catch (err) {
        console.error(`[ERROR CRITICO] ${symbol}: ${err.message}`);
    }
}

/**
 * Orquestador del ciclo de recolección
 */
async function run() {
    console.log(`[${new Date().toLocaleString()}] 🚀 Iniciando ciclo de recolección...`);
    for (const asset of ASSETS) {
        try {
            await syncAsset(asset);
        } catch (e) {
            console.error(`❌ Fallo fatal en ciclo para ${asset}: ${e.message}`);
        }
        await new Promise(r => setTimeout(r, 500));
    }
    console.log("✅ Ciclo completado. Esperando 2 minutos...");
}

// Ejecución inicial y bucle
run();
setInterval(run, 2 * 60 * 1000);
