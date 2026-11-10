param(
  [string]$ResourceGroup = 'UltraPlaysCode',
  [string]$Location = 'westus2',
  [string]$AppName = 'sunodlc',
  [string]$Image = ''
)
$ErrorActionPreference = 'Stop'
$env:PYTHONIOENCODING = 'utf-8'
Set-Location -LiteralPath $PSScriptRoot
$azureCli = Get-Command az -ErrorAction SilentlyContinue
if (!$azureCli) {
  $cliPath = 'C:\Program Files\Microsoft SDKs\Azure\CLI2\wbin\az.cmd'
  if (!(Test-Path -LiteralPath $cliPath)) { throw 'Install Microsoft Azure CLI first.' }
} else { $cliPath = $azureCli.Source }
& $cliPath account show --output none
if ($LASTEXITCODE -ne 0) { throw 'Sign in first with az login --use-device-code.' }
foreach ($provider in @('Microsoft.App','Microsoft.OperationalInsights','Microsoft.ContainerRegistry')) {
  & $cliPath provider register --namespace $provider --wait --output none
  if ($LASTEXITCODE -ne 0) { throw "Could not register $provider." }
}
# Internal ingress keeps the first deployment private until authentication and
# public access are deliberately configured.
if ($Image) {
  $registryServer = $Image.Split('/')[0]
  $registryName = $registryServer.Split('.')[0]
  $registryCredentials = & $cliPath acr credential show --name $registryName --output json | ConvertFrom-Json
  if ($LASTEXITCODE -ne 0) { throw 'Could not read registry credentials.' }
  & $cliPath containerapp up --name $AppName --resource-group $ResourceGroup --location $Location --environment "$AppName-env" --image $Image --registry-server $registryServer --registry-username $registryCredentials.username --registry-password $registryCredentials.passwords[0].value --ingress internal --target-port 3000
} else {
  & $cliPath containerapp up --name $AppName --resource-group $ResourceGroup --location $Location --source $PSScriptRoot --ingress internal --target-port 3000
}
if ($LASTEXITCODE -ne 0) { throw 'Azure container build/deployment failed.' }
& $cliPath containerapp update --name $AppName --resource-group $ResourceGroup --cpu 1 --memory 2Gi --min-replicas 0 --max-replicas 1 --output none
if ($LASTEXITCODE -ne 0) { throw 'Azure resource settings could not be applied.' }
$credentialsPath = Join-Path $PSScriptRoot 'deployment-credentials.txt'
if (Test-Path -LiteralPath $credentialsPath) {
  $appPassword = (Get-Content -LiteralPath $credentialsPath | Where-Object { $_.StartsWith('Password: ') }).Substring(10)
} else {
  $passwordBytes = New-Object byte[] 32
  $random = [Security.Cryptography.RandomNumberGenerator]::Create()
  try { $random.GetBytes($passwordBytes) } finally { $random.Dispose() }
  $appPassword = [Convert]::ToBase64String($passwordBytes)
  Set-Content -LiteralPath $credentialsPath -Value "Username: sunodlc`nPassword: $appPassword"
}
& $cliPath containerapp secret set --name $AppName --resource-group $ResourceGroup --secrets "app-password=$appPassword" --output none
if ($LASTEXITCODE -ne 0) { throw 'Could not save the application password in Azure.' }
& $cliPath containerapp update --name $AppName --resource-group $ResourceGroup --set-env-vars 'APP_PASSWORD=secretref:app-password' --output none
if ($LASTEXITCODE -ne 0) { throw 'Could not enable password protection.' }
# Public ingress is enabled only after the password-protected revision is ready.
& $cliPath containerapp ingress enable --name $AppName --resource-group $ResourceGroup --type external --target-port 3000 --transport auto --output none
if ($LASTEXITCODE -ne 0) { throw 'Could not enable HTTPS access.' }
& $cliPath containerapp show --name $AppName --resource-group $ResourceGroup --query '{name:name,status:properties.provisioningState,url:properties.configuration.ingress.fqdn}' --output json
