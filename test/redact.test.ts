import { describe, expect, it } from 'vitest';
import { redact } from '../src/shared/redact';

describe('redact', () => {
  it.each([
    ['mytool --password=hunter2', 'mytool --password=***'],
    ['mytool --password hunter2 --user bob', 'mytool --password *** --user bob'],
    ['deploy --api-key "abc def" --env prod', 'deploy --api-key *** --env prod'],
    ['vault login -token=s.abcdef', 'vault login -token=***'],
    ['export GITHUB_TOKEN=abc123', 'export GITHUB_TOKEN=***'],
    ['AWS_SECRET_ACCESS_KEY=xyz aws s3 ls', 'AWS_SECRET_ACCESS_KEY=*** aws s3 ls'],
    ['$env:OPENAI_API_KEY = "sk-live"', '$env:OPENAI_API_KEY = ***'],
    ['curl -H "Authorization: Bearer abcdefghijklmnop" https://x', 'curl -H "Authorization: Bearer ***" https://x'],
    ['git clone https://bob:s3cret@github.com/x/y.git', 'git clone https://bob:***@github.com/x/y.git'],
    ['curl -u admin:letmein https://x', 'curl -u admin:*** https://x'],
    ['mysql -u root -pS3cret db', 'mysql -u root -p*** db'],
    ['sshpass -p secret ssh host', 'sshpass -p *** ssh host'],
    ['$p = ConvertTo-SecureString "P@ss" -AsPlainText -Force', '$p = ConvertTo-SecureString *** -AsPlainText -Force'],
    ['echo ghp_0123456789abcdefghijklmnopqrstuvwxyz', 'echo ***'],
    ['aws configure set aws_access_key_id AKIAABCDEFGHIJKLMNOP', 'aws configure set aws_access_key_id ***'],
    ['claude --key sk-ant-api03-abcdefghijklmnopqrstuv', 'claude --key ***'],
  ])('masks %j', (input, expected) => {
    expect(redact(input)).toEqual({ text: expected, changed: true });
  });

  it.each([
    'git status',
    'git commit --author="Bob <b@x>" -m "fix password reset"',
    'ls --passive-mode',
    'kubectl get pods -n prod',
    'Get-ChildItem -Path C:\\Users',
    'ssh -p 2222 host',
    'curl https://example.com/path',
  ])('leaves %j alone', (input) => {
    expect(redact(input)).toEqual({ text: input, changed: false });
  });
});
