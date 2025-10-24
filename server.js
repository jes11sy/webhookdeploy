const express = require('express');
const { exec } = require('child_process');
const axios = require('axios');
const cron = require('node-cron');

const app = express();
const PORT = process.env.PORT || 8080;

// Environment variables
const DOCKERHUB_SECRET = process.env.DOCKERHUB_SECRET;
const TELEGRAM_BOT_TOKEN = process.env.TELEGRAM_BOT_TOKEN;
const TELEGRAM_CHAT_ID = process.env.TELEGRAM_CHAT_ID;

// Service mappings
const SERVICE_MAPPINGS = {
  // Backend services
  'auth-service': { namespace: 'backend', deployment: 'auth-service' },
  'auth': { namespace: 'backend', deployment: 'auth-service' },
  'masters-service': { namespace: 'backend', deployment: 'masters-service' },
  'masters': { namespace: 'backend', deployment: 'masters-service' },
  'orders-service': { namespace: 'backend', deployment: 'orders-service' },
  'orders': { namespace: 'backend', deployment: 'orders-service' },
  'users-service': { namespace: 'backend', deployment: 'users-service' },
  'users': { namespace: 'backend', deployment: 'users-service' },
  'calls-service': { namespace: 'backend', deployment: 'calls-service' },
  'calls': { namespace: 'backend', deployment: 'calls-service' },
  'reports-service': { namespace: 'backend', deployment: 'reports-service' },
  'reports': { namespace: 'backend', deployment: 'reports-service' },
  'avito-service': { namespace: 'backend', deployment: 'avito-service' },
  'avito': { namespace: 'backend', deployment: 'avito-service' },
  'cash-service': { namespace: 'backend', deployment: 'cash-service' },
  'cash': { namespace: 'backend', deployment: 'cash-service' },
  'files-service': { namespace: 'backend', deployment: 'files-service' },
  'files': { namespace: 'backend', deployment: 'files-service' },
  'backup-service': { namespace: 'backend', deployment: 'backup-service' },
  'backup': { namespace: 'backend', deployment: 'backup-service' },
  
  // Frontend services
  'callcentre-frontend': { namespace: 'frontend', deployment: 'callcentre-frontend' },
  'callcentre': { namespace: 'frontend', deployment: 'callcentre-frontend' },
  'front_callcentre': { namespace: 'frontend', deployment: 'callcentre-frontend' },
  'dircrm-frontend': { namespace: 'frontend', deployment: 'dircrm-frontend' },
  'front_dir': { namespace: 'frontend', deployment: 'dircrm-frontend' },
  'mastercrm-frontend': { namespace: 'frontend', deployment: 'mastercrm-frontend' },
  'mastercrm': { namespace: 'frontend', deployment: 'mastercrm-frontend' },
  
  // CRM services (3rd node)
  'notifications-service': { namespace: 'crm', deployment: 'notifications-service' },
  'notifications': { namespace: 'crm', deployment: 'notifications-service' },
  'realtime-service': { namespace: 'crm', deployment: 'realtime-service' },
  'realtime': { namespace: 'crm', deployment: 'realtime-service' }
};

app.use(express.json());

// Log all incoming requests
app.use((req, res, next) => {
  console.log(`📥 ${req.method} ${req.path} - ${new Date().toISOString()}`);
  console.log(`📥 Headers:`, JSON.stringify(req.headers, null, 2));
  console.log(`📥 Body:`, JSON.stringify(req.body, null, 2));
  next();
});

// Track services that were recently updated
const updatedServices = new Map();

// Health check
app.get('/health', (req, res) => {
  res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// GitHub Actions webhook
app.post('/webhook/github', (req, res) => {
  try {
    console.log('🐙 GitHub Actions webhook received');
    console.log('🐙 Webhook data:', JSON.stringify(req.body, null, 2));
    
    const { action, workflow_run, repository } = req.body;
    
    if (action === 'completed' && workflow_run) {
      const { conclusion, status, head_branch } = workflow_run;
      const repoName = repository?.name || 'unknown';
      
      console.log(`🐙 GitHub Actions completed for ${repoName}: ${conclusion}`);
      
      if (conclusion === 'success') {
        sendTelegramNotification(
          `✅ <b>GitHub Actions</b> успешно завершен!\n` +
          `Репозиторий: ${repoName}\n` +
          `Ветка: ${head_branch}\n` +
          `Статус: ${conclusion}`
        );
      } else {
        sendTelegramNotification(
          `❌ <b>GitHub Actions</b> завершен с ошибкой!\n` +
          `Репозиторий: ${repoName}\n` +
          `Ветка: ${head_branch}\n` +
          `Статус: ${conclusion}`
        );
      }
    } else if (action === 'requested' && workflow_run) {
      // Workflow запустился
      const { name, head_branch } = workflow_run;
      const repoName = repository?.name || 'unknown';
      
      console.log(`🐙 GitHub Actions started for ${repoName}: ${name}`);
      
      sendTelegramNotification(
        `🚀 <b>GitHub Actions</b> запущен!\n` +
        `Репозиторий: ${repoName}\n` +
        `Ветка: ${head_branch}\n` +
        `Workflow: ${name}`
      );
    } else if (action === 'in_progress' && workflow_run) {
      // Workflow выполняется
      const { name, head_branch } = workflow_run;
      const repoName = repository?.name || 'unknown';
      
      console.log(`🐙 GitHub Actions in progress for ${repoName}: ${name}`);
      
      sendTelegramNotification(
        `⏳ <b>GitHub Actions</b> выполняется...\n` +
        `Репозиторий: ${repoName}\n` +
        `Ветка: ${head_branch}\n` +
        `Workflow: ${name}`
      );
    } else if (action === 'opened' || action === 'synchronize') {
      // Push события
      const repoName = repository?.name || 'unknown';
      const branch = req.body.ref?.replace('refs/heads/', '') || 'unknown';
      
      console.log(`🐙 GitHub push received for ${repoName}: ${branch}`);
      
      sendTelegramNotification(
        `🚀 <b>GitHub Push</b> получен!\n` +
        `Репозиторий: ${repoName}\n` +
        `Ветка: ${branch}\n` +
        `Действие: ${action}`
      );
    } else {
      console.log(`🐙 GitHub webhook action: ${action}, workflow_run: ${!!workflow_run}`);
    }
    
    res.status(200).json({ message: 'GitHub webhook processed successfully' });
  } catch (error) {
    console.error('GitHub webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Docker Hub webhook
app.post('/webhook/dockerhub', async (req, res) => {
  try {
    // Docker Hub doesn't send signature, so we skip verification
    console.log('📦 Docker Hub webhook received');
    console.log('📦 Docker Hub webhook body:', JSON.stringify(req.body, null, 2));

    const { repository, push_data } = req.body;
    
    if (!repository || !push_data) {
      console.log('❌ Invalid Docker Hub webhook format');
      return res.status(400).json({ error: 'Invalid webhook format' });
    }
    
    const imageName = repository.repo_name;
    const tag = push_data.tag;

    console.log(`📦 Docker Hub webhook received for ${imageName}:${tag}`);

    // Find matching service
    const serviceKey = Object.keys(SERVICE_MAPPINGS).find(key => 
      imageName.includes(key)
    );

    if (!serviceKey) {
      console.log(`❌ No service mapping found for ${imageName}`);
      return res.status(200).json({ message: 'No service mapping found' });
    }

    const serviceConfig = SERVICE_MAPPINGS[serviceKey];
    
    // Update deployment - ВСЕГДА используем latest тег
    try {
      await updateDeployment(serviceConfig.namespace, serviceConfig.deployment, imageName, 'latest');
      
      console.log(`✅ Successfully updated ${serviceConfig.deployment}`);
      
      // Mark service as updated for monitoring
      updatedServices.set(serviceKey, true);
      
      sendTelegramNotification(`🚀 <b>${serviceConfig.deployment}</b> обновлен до ${imageName}:latest\n⏳ Ожидаем запуск...`);
      
      res.status(200).json({ message: 'Webhook processed successfully' });
    } catch (error) {
      console.error(`❌ Failed to update ${serviceConfig.deployment}:`, error);
      sendTelegramNotification(`❌ Ошибка обновления ${serviceConfig.deployment}: ${error.message}`);
      res.status(500).json({ error: 'Failed to update deployment' });
    }

  } catch (error) {
    console.error('Webhook processing error:', error);
    res.status(500).json({ error: 'Internal server error' });
  }
});

// Update deployment function
async function updateDeployment(namespace, deployment, image, tag) {
  return new Promise((resolve, reject) => {
    const fullImageName = `${image}:${tag}`;
    const command = `kubectl set image deployment/${deployment} ${deployment}=${fullImageName} -n ${namespace}`;
    
    console.log(`🔄 Executing: ${command}`);
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        console.error(`❌ kubectl error: ${error}`);
        reject(error);
        return;
      }
      
      console.log(`✅ kubectl output: ${stdout}`);
      if (stderr) {
        console.log(`⚠️ kubectl stderr: ${stderr}`);
      }
      
      resolve(stdout);
    });
  });
}

// Send Telegram notification
async function sendTelegramNotification(message) {
  if (!TELEGRAM_BOT_TOKEN || !TELEGRAM_CHAT_ID) {
    console.log('Telegram credentials not configured');
    return;
  }

  try {
    const url = `https://api.telegram.org/bot${TELEGRAM_BOT_TOKEN}/sendMessage`;
    const data = {
      chat_id: TELEGRAM_CHAT_ID,
      text: message,
      parse_mode: 'HTML'
    };

    console.log('📱 Sending Telegram notification to:', TELEGRAM_CHAT_ID);
    console.log('📱 Message:', message);
    
    const response = await axios.post(url, data);
    console.log('📱 Telegram notification sent successfully:', response.status);
  } catch (error) {
    console.error('❌ Failed to send Telegram notification:', error.message);
    if (error.response) {
      console.error('❌ Response status:', error.response.status);
      console.error('❌ Response data:', error.response.data);
    }
  }
}

// Monitor deployments status (runs every 30 seconds)
cron.schedule('*/30 * * * * *', async () => {
  console.log('🔍 Checking deployments status...');
  
  for (const [serviceName, config] of Object.entries(SERVICE_MAPPINGS)) {
    try {
      const status = await getDeploymentStatus(config.namespace, config.deployment);
      
      // Check if service is running (1/1 or more)
      if (status.isReady && status.readyReplicas > 0) {
        console.log(`✅ ${serviceName}: ${status.readyReplicas}/${status.replicas} running`);
        
        // Send success notification if this service was recently updated
        if (updatedServices.has(serviceName)) {
          await sendTelegramNotification(
            `✅ <b>${serviceName}</b> успешно обновлен и работает!\n` +
            `Статус: ${status.readyReplicas}/${status.replicas} running\n` +
            `Namespace: ${config.namespace}`
          );
          updatedServices.delete(serviceName);
        }
      } else {
        console.log(`⚠️ ${serviceName}: ${status.readyReplicas}/${status.replicas} running`);
      }
    } catch (error) {
      console.error(`❌ Error checking ${serviceName}:`, error.message);
    }
  }
});

// Get deployment status
async function getDeploymentStatus(namespace, deployment) {
  return new Promise((resolve, reject) => {
    const command = `kubectl get deployment ${deployment} -n ${namespace} -o json`;
    
    exec(command, (error, stdout, stderr) => {
      if (error) {
        reject(error);
        return;
      }
      
      try {
        const deploymentInfo = JSON.parse(stdout);
        const status = deploymentInfo.status;
        
        resolve({
          name: deployment,
          namespace: namespace,
          replicas: status.replicas || 0,
          readyReplicas: status.readyReplicas || 0,
          availableReplicas: status.availableReplicas || 0,
          updatedReplicas: status.updatedReplicas || 0,
          conditions: status.conditions || [],
          isReady: (status.readyReplicas || 0) === (status.replicas || 0) && (status.replicas || 0) > 0
        });
      } catch (parseError) {
        reject(parseError);
      }
    });
  });
}

// Start server
app.listen(PORT, () => {
  console.log(`🚀 Webhook Server running on port ${PORT}`);
  console.log(`📡 Docker Hub webhook endpoint: /webhook/dockerhub`);
  console.log(`📡 GitHub webhook endpoint: /webhook/github`);
  console.log(`📊 Status endpoint: /health`);
});

// Graceful shutdown
process.on('SIGTERM', () => {
  console.log('🛑 Received SIGTERM, shutting down gracefully');
  process.exit(0);
});

process.on('SIGINT', () => {
  console.log('🛑 Received SIGINT, shutting down gracefully');
  process.exit(0);
});
