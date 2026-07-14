-- Script para garantizar que 'codigo_grupo' sea único, necesario para el proceso idempotente de ETL
ALTER TABLE public.grupos ADD CONSTRAINT grupos_codigo_ciclo_key UNIQUE (codigo_grupo, ciclo_id);
