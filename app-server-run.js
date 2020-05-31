#!/usr/bin/env node

require('./app-server')(require('minimist')(process.argv.slice(2)));
