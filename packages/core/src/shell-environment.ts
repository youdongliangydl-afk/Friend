/** Keep inference credentials in the SDK host, outside project command environments. */
export function shellEnvironment(env:NodeJS.ProcessEnv=process.env):NodeJS.ProcessEnv {
  return Object.fromEntries(Object.entries(env).filter(([key])=>!/API_?KEY|TOKEN|SECRET|PASSWORD|CREDENTIAL/i.test(key)));
}
