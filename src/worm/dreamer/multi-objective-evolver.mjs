// src/worm/dreamer/multi-objective-evolver.mjs
// Multi-objective evolutionary optimization per regime.
// Maintains Pareto fronts of non-dominated genomes across multiple objectives:
// - Maximize Alpha (relative ROI + conviction)
// - Minimize Drawdown
// - Maximize Regime Robustness
// - Maximize Conviction Alignment
//
// Designed to work alongside the existing grid search in ScientificOptimizer.

export class MultiObjectiveEvolver {
  constructor(objectives = {}) {
    this.objectives = objectives;
  }

  _dominates(ind1, ind2) {
    const o1 = ind1.objectives;
    const o2 = ind2.objectives;
    let betterInOne = false;

    for (const key in o1) {
      if (o1[key] < o2[key]) return false;
      if (o1[key] > o2[key]) betterInOne = true;
    }
    return betterInOne;
  }

  rankPopulation(population) {
    population.forEach(ind => {
      ind.dominationCount = 0;
      ind.dominatedSolutions = [];
      ind.rank = Infinity;
    });

    for (let i = 0; i < population.length; i++) {
      for (let j = 0; j < population.length; j++) {
        if (i === j) continue;
        if (this._dominates(population[i], population[j])) {
          population[i].dominatedSolutions.push(population[j]);
        } else if (this._dominates(population[j], population[i])) {
          population[i].dominationCount++;
        }
      }
    }

    let front = 1;
    let currentFront = population.filter(ind => ind.dominationCount === 0);

    while (currentFront.length > 0) {
      currentFront.forEach(ind => (ind.rank = front));
      const nextFront = [];
      currentFront.forEach(ind => {
        ind.dominatedSolutions.forEach(dom => {
          dom.dominationCount--;
          if (dom.dominationCount === 0) nextFront.push(dom);
        });
      });
      currentFront = nextFront;
      front++;
    }
  }

  evolve(population, regime, mutateFn, crossoverFn) {
    if (!population || population.length < 6) return population;

    this.rankPopulation(population);

    const sorted = [...population].sort((a, b) => a.rank - b.rank);
    const survivors = sorted.slice(0, 8);

    const newOffspring = [];
    while (newOffspring.length < 6 && survivors.length >= 2) {
      const p1 = survivors[Math.floor(Math.random() * survivors.length)];
      const p2 = survivors[Math.floor(Math.random() * survivors.length)];

      let child = crossoverFn(p1.genome, p2.genome);
      child = mutateFn(child, regime);

      newOffspring.push({
        genome: child,
        objectives: null,
        rank: Infinity,
        regime
      });
    }

    return [...survivors, ...newOffspring];
  }
}