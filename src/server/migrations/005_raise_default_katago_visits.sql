UPDATE katago_settings
SET analysis_visits = 2000,
    updated_at = CURRENT_TIMESTAMP
WHERE analysis_visits = 500;
