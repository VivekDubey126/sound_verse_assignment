import { Knex } from 'knex';

export async function seed(knex: Knex): Promise<void> {
  // Upsert plans — safe to re-run
  const plans = [
    {
      name: 'sandbox',
      display_name: 'Sandbox',
      monthly_allowance: 0,
      parallel_generations: 1,
      requests_per_hour: 60,
      requests_per_day: 500,
      licenses_available: JSON.stringify(['royalty_free']),
      beyond_allowance: 'none',
    },
    {
      name: 'starter',
      display_name: 'Starter',
      monthly_allowance: 200,
      parallel_generations: 3,
      requests_per_hour: 300,
      requests_per_day: 3000,
      licenses_available: JSON.stringify(['royalty_free', 'sync']),
      beyond_allowance: 'hard_stop',
    },
    {
      name: 'growth',
      display_name: 'Growth',
      monthly_allowance: 2000,
      parallel_generations: 10,
      requests_per_hour: 2000,
      requests_per_day: 30000,
      licenses_available: JSON.stringify(['royalty_free', 'sync', 'full_ownership']),
      beyond_allowance: 'overage',
    },
  ];

  for (const plan of plans) {
    const existing = await knex('plans').where('name', plan.name).first();
    if (existing) {
      await knex('plans').where('name', plan.name).update(plan);
    } else {
      await knex('plans').insert(plan);
    }
  }
}

