<?php

use Illuminate\Database\Migrations\Migration;
use Illuminate\Database\Schema\Blueprint;
use Illuminate\Support\Facades\Schema;

return new class extends Migration
{
    public function up(): void
    {
        Schema::create('deals', function (Blueprint $table) {
            $table->id();
            $table->foreignId('company_id')->constrained();
            $table->unsignedBigInteger('contact_id')->nullable();
            $table->unsignedBigInteger('owner_id');
            $table->foreignId('pipeline_stage_id')->constrained('pipeline_stages');
            $table->string('title');
            $table->decimal('amount', 12, 2)->default(0);
            $table->char('currency', 3)->default('USD');
            $table->string('status', 10)->default('open');
            $table->timestamp('closed_at')->nullable();
            $table->timestamps();

            $table->foreign('contact_id')->references('id')->on('contacts')->nullOnDelete();
        });
    }

    public function down(): void
    {
        Schema::dropIfExists('deals');
    }
};
