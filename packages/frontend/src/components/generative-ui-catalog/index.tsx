import { defineRegistry } from '@json-render/react';
import { catalog } from '@moca/generative-ui-catalog';
import DataTable from './DataTable';
import MetricCard from './MetricCard';
import Stack from './Stack';
import Grid from './Grid';
import BarChart from './BarChart';
import LineChart from './LineChart';
import PieChart from './PieChart';

/**
 * Registry maps catalog component definitions to React implementations.
 * The catalog (SSoT) is defined in @moca/generative-ui-catalog.
 */
const { registry } = defineRegistry(catalog, {
  components: {
    Stack,
    Grid,
    DataTable,
    MetricCard,
    BarChart,
    LineChart,
    PieChart,
  },
});

export { catalog, registry };
