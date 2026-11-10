<script setup lang="ts">
import SessionSidebar from '../components/SessionSidebar.vue';
</script>

<template>
  <div class="projects-page">
    <SessionSidebar />
  </div>
</template>

<style scoped>
.projects-page {
  flex: 1;
  display: flex;
  min-height: 0;
  min-width: 0;
  height: 100%;
  overflow: hidden;
}
</style>
