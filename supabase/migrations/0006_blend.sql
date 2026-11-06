-- Blend lab: separate weights for totals, and slope corrections from the fit.
alter table rating_sources add column if not exists total_weight numeric;          -- null = use weight
alter table model_settings add column if not exists margin_slope numeric not null default 1;  -- spread = slope × rating gap
alter table model_settings add column if not exists points_slope numeric not null default 1;  -- team points = avg + slope × (off + opp def)
